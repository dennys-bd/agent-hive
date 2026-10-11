import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { CommentRow, IssueRow } from './rows.js';

/** The read model's file in the daemon's home (#765). A cache: deleting it costs one full resync, so it has no backup. */
export const READ_MODEL_FILE = 'read-model.sqlite';
const FILE_MODE = 0o600; // as credentials.json: the bodies of private repositories' issues live here
const MEMORY = ':memory:';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (source TEXT, node_id TEXT, repository TEXT, number INTEGER, kind TEXT, state TEXT, title TEXT,
  body TEXT, author TEXT, labels TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT, comments INTEGER,
  PRIMARY KEY (source, node_id));
CREATE INDEX IF NOT EXISTS issues_by_repo ON issues (source, repository, kind, state, updated_at);
CREATE TABLE IF NOT EXISTS comments (source TEXT, node_id TEXT, issue_node_id TEXT, repository TEXT, author TEXT, body TEXT,
  created_at TEXT, updated_at TEXT, PRIMARY KEY (source, node_id));
CREATE INDEX IF NOT EXISTS comments_by_issue ON comments (source, issue_node_id, created_at);
CREATE TABLE IF NOT EXISTS sync_cursors (scope TEXT PRIMARY KEY, cursor TEXT, etag TEXT, synced_at TEXT);`;

// The updated_at rule (#765): a row is replaced only by one at least as new, so a sync page read before a write never undoes it. GitHub's
// ISO strings (one format, Z) sort as the instants they name. A row identical to the stored one writes nothing, so a write means a change
const UPSERT_ISSUE = `INSERT INTO issues (source, node_id, repository, number, kind, state, title, body, author, labels, created_at, updated_at, closed_at, comments)
  VALUES ($source, $nodeId, $repository, $number, $kind, $state, $title, $body, $author, $labels, $createdAt, $updatedAt, $closedAt, $comments)
  ON CONFLICT (source, node_id) DO UPDATE SET repository = excluded.repository, number = excluded.number, kind = excluded.kind, state = excluded.state,
  title = excluded.title, body = excluded.body, author = excluded.author, labels = excluded.labels, created_at = excluded.created_at,
  updated_at = excluded.updated_at, closed_at = excluded.closed_at, comments = excluded.comments
  WHERE excluded.updated_at >= issues.updated_at AND (excluded.repository, excluded.number, excluded.kind, excluded.state, excluded.title, excluded.body,
    excluded.author, excluded.labels, excluded.created_at, excluded.updated_at, excluded.closed_at, excluded.comments) IS NOT
    (issues.repository, issues.number, issues.kind, issues.state, issues.title, issues.body, issues.author, issues.labels, issues.created_at,
    issues.updated_at, issues.closed_at, issues.comments)`;
const UPSERT_COMMENT = `INSERT INTO comments (source, node_id, issue_node_id, repository, author, body, created_at, updated_at)
  VALUES ($source, $nodeId, $issueNodeId, $repository, $author, $body, $createdAt, $updatedAt)
  ON CONFLICT (source, node_id) DO UPDATE SET issue_node_id = excluded.issue_node_id, repository = excluded.repository, author = excluded.author,
  body = excluded.body, created_at = excluded.created_at, updated_at = excluded.updated_at
  WHERE excluded.updated_at >= comments.updated_at AND (excluded.issue_node_id, excluded.repository, excluded.author, excluded.body, excluded.created_at,
    excluded.updated_at) IS NOT (comments.issue_node_id, comments.repository, comments.author, comments.body, comments.created_at, comments.updated_at)`;
const UPSERT_CURSOR = `INSERT INTO sync_cursors (scope, cursor, etag, synced_at) VALUES ($scope, $cursor, $etag, $syncedAt)
  ON CONFLICT (scope) DO UPDATE SET cursor = excluded.cursor, etag = excluded.etag, synced_at = excluded.synced_at`;

/** A scope's place in its sync (#765): the last updated_at stored, the first page's ETag while that cursor stands, and when it ran. */
export interface SyncCursor { cursor: string | null; etag: string | null; syncedAt: string }
export type RowTable = 'issues' | 'comments';

/** The read model (#765): one upsert per entity, the cursors and the views' queries, every one scoped to a source. */
export interface ReadModel {
  upsertIssue(row: IssueRow): boolean; // whether it wrote: false when the stored row is newer
  upsertComment(row: CommentRow): boolean;
  removeIssue(source: string, nodeId: string): void; // its comments with it
  removeComment(source: string, nodeId: string): void;
  cursor(scope: string): SyncCursor | undefined;
  setCursor(scope: string, cursor: SyncCursor): void;
  issues(source: string, repository: string, state: IssueRow['state']): IssueRow[]; // issues only, newest update first
  issue(source: string, repository: string, number: number): IssueRow | undefined; // an issue, never a PR
  nodeIdOf(source: string, repository: string, number: number): string | undefined; // an issue's or a PR's: what a REST comment resolves
  comments(source: string, issueNodeId: string): CommentRow[]; // oldest first
  nodeIds(source: string, repository: string, table: RowTable): string[];
  transaction<T>(run: () => T): T;
  close(): void;
}

type Row = Record<string, SQLOutputValue>;
const text = (row: Row, key: string): string => String(row[key]);
const nullable = (row: Row, key: string): string | null => (row[key] === null ? null : String(row[key]));
const written = (result: { changes: number | bigint }): boolean => Number(result.changes) > 0;

function issueOf(row: Row): IssueRow {
  return {
    source: text(row, 'source'), nodeId: text(row, 'node_id'), repository: text(row, 'repository'), number: Number(row.number),
    kind: row.kind === 'pr' ? 'pr' : 'issue', state: row.state === 'closed' ? 'closed' : 'open', title: text(row, 'title'), body: text(row, 'body'),
    author: nullable(row, 'author'), labels: JSON.parse(text(row, 'labels')) as string[], createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'), closedAt: nullable(row, 'closed_at'), comments: Number(row.comments),
  };
}

function commentOf(row: Row): CommentRow {
  return {
    source: text(row, 'source'), nodeId: text(row, 'node_id'), issueNodeId: text(row, 'issue_node_id'), repository: text(row, 'repository'),
    author: nullable(row, 'author'), body: text(row, 'body'), createdAt: text(row, 'created_at'), updatedAt: text(row, 'updated_at'),
  };
}

function writesOf(db: DatabaseSync): Pick<ReadModel, 'upsertIssue' | 'upsertComment' | 'removeIssue' | 'removeComment' | 'setCursor'> {
  const issue = db.prepare(UPSERT_ISSUE);
  const comment = db.prepare(UPSERT_COMMENT);
  const cursor = db.prepare(UPSERT_CURSOR);
  const dropIssue = db.prepare('DELETE FROM issues WHERE source = ? AND node_id = ?');
  const dropComments = db.prepare('DELETE FROM comments WHERE source = ? AND issue_node_id = ?');
  const dropComment = db.prepare('DELETE FROM comments WHERE source = ? AND node_id = ?');
  return {
    // every key of the row is one named parameter; labels travel as a JSON array of names
    upsertIssue: (row) => written(issue.run({ ...row, labels: JSON.stringify(row.labels) })),
    upsertComment: (row) => written(comment.run({ ...row })),
    removeIssue: (source, nodeId) => {
      dropComments.run(source, nodeId);
      dropIssue.run(source, nodeId);
    },
    removeComment: (source, nodeId) => { dropComment.run(source, nodeId); },
    setCursor: (scope, value) => { cursor.run({ scope, ...value }); },
  };
}

function readsOf(db: DatabaseSync): Pick<ReadModel, 'cursor' | 'issues' | 'issue' | 'nodeIdOf' | 'comments' | 'nodeIds'> {
  const cursor = db.prepare('SELECT cursor, etag, synced_at FROM sync_cursors WHERE scope = ?');
  const issues = db.prepare("SELECT * FROM issues WHERE source = ? AND repository = ? AND kind = 'issue' AND state = ? ORDER BY updated_at DESC");
  const issue = db.prepare("SELECT * FROM issues WHERE source = ? AND repository = ? AND number = ? AND kind = 'issue'");
  const nodeId = db.prepare('SELECT node_id FROM issues WHERE source = ? AND repository = ? AND number = ?');
  const comments = db.prepare('SELECT * FROM comments WHERE source = ? AND issue_node_id = ? ORDER BY created_at');
  const ids = {
    issues: db.prepare('SELECT node_id FROM issues WHERE source = ? AND repository = ?'),
    comments: db.prepare('SELECT node_id FROM comments WHERE source = ? AND repository = ?'),
  };
  return {
    cursor: (scope) => {
      const row = cursor.get(scope);
      return row === undefined ? undefined : { cursor: nullable(row, 'cursor'), etag: nullable(row, 'etag'), syncedAt: text(row, 'synced_at') };
    },
    issues: (source, repository, state) => issues.all(source, repository, state).map(issueOf),
    issue: (source, repository, number) => {
      const row = issue.get(source, repository, number);
      return row === undefined ? undefined : issueOf(row);
    },
    nodeIdOf: (source, repository, number) => {
      const row = nodeId.get(source, repository, number);
      return row === undefined ? undefined : text(row, 'node_id');
    },
    comments: (source, issueNodeId) => comments.all(source, issueNodeId).map(commentOf),
    nodeIds: (source, repository, table) => ids[table].all(source, repository).map((row) => text(row, 'node_id')),
  };
}

function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// WAL keeps a -wal and a -shm beside the database: all three get the owner-only mode
function restrict(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, FILE_MODE);
}

/** Opens, and creates on first use, the read model at `path`; `:memory:` keeps it in memory (the tests, the measurement). */
export function openReadModel(path: string): ReadModel {
  if (path !== MEMORY) writeFileSync(path, '', { flag: 'a', mode: FILE_MODE }); // owner-only from creation, not after sqlite made it with the umask's mode
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL'); // a reader outside the daemon (the sqlite3 CLI during the spike) never blocks its writes
  db.exec(SCHEMA);
  if (path !== MEMORY) restrict(path);
  return { ...writesOf(db), ...readsOf(db), transaction: <T>(run: () => T): T => inTransaction(db, run), close: () => db.close() };
}
