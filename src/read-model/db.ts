import { chmodSync, closeSync, existsSync, openSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { MergeMethod, PrClosingIssue, PrRow, PrState, ProjectPr, RepoPrs } from '../types.js';
import { prDetailsOf } from './pr-details.js';
import { itemTablesOf } from './item-tables.js';
import { pullTablesOf } from './pull-tables.js';
import type { CheckRow, CommentRow, FieldValueRow, IssueDetails, IssueRow, IssueView, ItemRow, OpenPull, PullFlags, PullKey, PullPoll, PrPage, PullPage, PullRead, PullToRead, ProjectFieldRow, RelationKind, RelationRow, RepoRow, ReviewRow, StoredItemRows, UpsertOrigin } from './rows.js';
import { MIGRATIONS } from './schema.js';
import { inTransaction, issueOf, nullable, prOf, type Row, stamp, text, upsertSql, written } from './sql.js';

/** The read model's file in the daemon's home (#178). A cache: deleting it costs one full resync, so it has no backup. */
export const READ_MODEL_FILE = 'read-model.sqlite';
const FILE_MODE = 0o600; // as credentials.json: the bodies of private repositories' issues live here
const MEMORY = ':memory:';
const SIDE_FILES = ['', '-wal', '-shm'] as const;
const ISSUE_COLUMNS = ['source', 'node_id', 'repository', 'number', 'kind', 'state', 'title', 'body', 'author', 'labels', 'assignees', 'created_at', 'updated_at', 'closed_at', 'comments'];
const COMMENT_COLUMNS = ['source', 'node_id', 'issue_node_id', 'repository', 'url', 'author', 'body', 'created_at', 'updated_at'];
const NO_LIMIT = -1; // SQLite's LIMIT -1: every row
// The changed-row guard of upsertSql without its updated_at rule: a repository has no updated_at, and only the sync writes it
const UPSERT_REPO = `INSERT INTO repos (source, repository, url, can_push, issues_enabled, fork_parent, pushed_at, methods)
  VALUES ($source, $repository, $url, $canPush, $issuesEnabled, $forkParent, $pushedAt, $methods)
  ON CONFLICT (source, repository) DO UPDATE SET url = excluded.url, can_push = excluded.can_push, issues_enabled = excluded.issues_enabled,
    fork_parent = excluded.fork_parent, pushed_at = excluded.pushed_at, methods = excluded.methods
  WHERE (excluded.url, excluded.can_push, excluded.issues_enabled, excluded.fork_parent, excluded.pushed_at, excluded.methods)
    IS NOT (repos.url, repos.can_push, repos.issues_enabled, repos.fork_parent, repos.pushed_at, repos.methods)`;
const COUNTS = `SELECT COUNT(*) FILTER (WHERE kind = 'issue' AND state = 'open') AS open_issues,
  COUNT(*) FILTER (WHERE kind = 'issue' AND state = 'closed') AS closed_issues, COUNT(*) FILTER (WHERE kind = 'pr' AND state = 'open') AS open_prs,
  MAX(updated_at) AS last FROM issues WHERE source = ? AND repository = ?`;
const UPSERT_SCOPE = `INSERT INTO sync_scopes (source, repository, kind, cursor, etag, synced_at) VALUES ($source, $repository, $kind, $cursor, $etag, $syncedAt)
  ON CONFLICT (source, repository, kind) DO UPDATE SET cursor = excluded.cursor, etag = excluded.etag, synced_at = excluded.synced_at`;

/** The `repo` and `labels` kinds keep only an ETag: each is replaced whole on a 200 (#181). `pulls`: a PR's own fields changed (#186). */
export type SyncKind = 'issues' | 'comments' | 'repo' | 'labels' | 'pulls';
/** A part of a PR's poll (#186, #187): pulls/{n}, its head's check runs, combined status and check suites, and its reviews. */
export type PullPart = 'pr' | 'runs' | 'status' | 'suites' | 'reviews';
/** A row of sync_scopes (#180): the two incremental scopes, the full listing's, whose synced_at spaces it, and an open PR's poll parts (#186),
 * whose cursor holds the part's own reading, so a 304 still has it. kind is TEXT: no migration. */
export type ScopeKind = SyncKind | 'reconcile' | `pull/${number}/${PullPart}`;
/** Which PR rows a list reads (#186): one login's on an original, and at most `limit`. */
export interface PrFilter { author?: string; limit?: number }
/** A scope's place in its sync: the `since` cursor, the first page's ETag, and the time of the last complete round. */
export interface SyncScope { cursor: string | null; etag: string | null; syncedAt: string | null }

/** What the repository summary counts from the rows (#181): open and closed issues, open PRs, the newest updated_at of either kind. */
export interface RepoCounts { openIssues: number; closedIssues: number; openPrs: number; lastUpdatedAt?: string }

/** The read model (#178): one upsert per entity, the scopes and the views' queries, every one scoped to a source. */
export interface ReadModel {
  upsertIssue(row: IssueRow, origin: UpsertOrigin): boolean; // whether it wrote
  upsertComment(row: CommentRow, origin: UpsertOrigin): boolean;
  setClosingPrs(source: string, issueNodeId: string, prs: ProjectPr[]): void; // replaces the set
  removeIssue(source: string, nodeId: string): void; // its comments, links, pulls row, reviews and checks with it
  removeComment(source: string, nodeId: string): void;
  scope(source: string, repository: string, kind: ScopeKind): SyncScope | undefined;
  setScope(source: string, repository: string, kind: ScopeKind, scope: SyncScope): void;
  issues(source: string, repository: string, state: IssueRow['state'], limit?: number): IssueView[]; // issues only, newest update first
  setRepo(row: RepoRow): boolean; // whether it wrote; an identical row writes nothing
  repo(source: string, repository: string): RepoRow | undefined;
  setLabels(source: string, repository: string, names: string[]): boolean; // replaces the set; whether it changed
  labels(source: string, repository: string): string[]; // by name
  counts(source: string, repository: string): RepoCounts;
  issue(source: string, repository: string, number: number): IssueView | undefined; // never a PR
  issueByNode(source: string, nodeId: string): IssueRow | undefined; // #187: an issue's or a PR's row, as stored
  nodeIdOf(source: string, repository: string, number: number): string | undefined; // an issue's or a PR's
  comments(source: string, issueNodeId: string): CommentRow[]; // oldest first
  nodeIds(source: string, repository: string, table: 'issues' | 'comments'): string[];
  setPullFlags(flags: PullFlags): boolean; // #186: each pulls writer answers whether it wrote
  setPullRead(key: PullKey, read: PullRead): boolean;
  setPullPoll(key: PullKey, poll: PullPoll): boolean;
  pullsToRead(source: string, repository: string, author?: string): PullToRead[]; // by number
  openPulls(source: string, repository: string, author?: string): OpenPull[]; // by number
  prs(source: string, repository: string, state: PrState, filter?: PrFilter): PrRow[]; // newest update first
  prCounts(source: string, repository: string, author?: string): RepoPrs['counts'];
  removeScopes(source: string, repository: string, prefix: string): void;
  setPullPage(key: PullKey, page: PullPage): boolean; // #187: the page's own rows; each writer answers whether it wrote
  setPullChecks(key: PullKey, checks: CheckRow[]): boolean; // replaces the set
  setPullAwaiting(key: PullKey, workflows: string[]): boolean;
  setPullCloses(key: PullKey, closes: PrClosingIssue[]): boolean;
  upsertReview(row: ReviewRow, origin: UpsertOrigin): boolean;
  pullAt(source: string, repository: string, number: number): OpenPull | undefined; // a PR's, open or not
  prPage(source: string, repository: string, number: number): PrPage | undefined; // never an issue
  upsertItem(row: ItemRow, origin: UpsertOrigin): boolean; // #190: a Project item's own columns; whether it wrote
  setItemValues(source: string, itemNodeId: string, values: FieldValueRow[]): void; // #282: replaces the item's set values
  setIssueRelations(source: string, issueNodeId: string, kinds: RelationKind[], rows: RelationRow[]): void; // replaces those kinds' rows
  setBlocking(source: string, itemNodeId: string, rows: RelationRow[] | null): void; // blocking_read 1 and the rows; null: 0, the issue is gone
  setIssueDetails(source: string, issueNodeId: string, updatedAt: string, details: IssueDetails, origin: UpsertOrigin): boolean; // the replace rule's, on the row's own updated_at
  setProjectFields(source: string, project: string, fields: ProjectFieldRow[]): void; // replaced whole
  projectFields(source: string, project: string): ProjectFieldRow[]; // in the project's order
  setListing(source: string, project: string, nodeIds: string[]): void; // replaces the Project's listing whole
  removeUnlisted(source: string, project: string): void; // the items it no longer names, their values and relations; their issues stay
  listing(source: string, project: string): string[]; // item node ids in position order
  itemRows(source: string, nodeIds: string[]): StoredItemRows[]; // in the order asked; an id not stored is skipped
  transaction<T>(run: () => T): T;
  close(): void;
}

/** `now` is the clock of the written_at window; `migrations` replaces MIGRATIONS for the tests only. */
export interface OpenOptions { now?: () => number; migrations?: readonly string[] }

type Sqlite = typeof DatabaseSync;
function commentOf(row: Row): CommentRow {
  return {
    source: text(row, 'source'), nodeId: text(row, 'node_id'), issueNodeId: text(row, 'issue_node_id'), repository: text(row, 'repository'),
    url: text(row, 'url'), author: nullable(row, 'author'), body: text(row, 'body'), createdAt: text(row, 'created_at'), updatedAt: text(row, 'updated_at'),
  };
}

function upsertsOf(db: DatabaseSync, now: () => number): Pick<ReadModel, 'upsertIssue' | 'upsertComment' | 'setScope'> {
  const issue = db.prepare(upsertSql('issues', ISSUE_COLUMNS));
  const comment = db.prepare(upsertSql('comments', COMMENT_COLUMNS));
  const scope = db.prepare(UPSERT_SCOPE);
  return {
    // every key of the row is one named parameter; labels and assignees travel as JSON arrays
    upsertIssue: (row, origin) => written(issue.run({ ...row, labels: JSON.stringify(row.labels), assignees: JSON.stringify(row.assignees), ...stamp(now(), origin) })),
    upsertComment: (row, origin) => written(comment.run({ ...row, ...stamp(now(), origin) })),
    setScope: (source, repository, kind, value) => { scope.run({ source, repository, kind, ...value }); },
  };
}

function removalsOf(db: DatabaseSync): Pick<ReadModel, 'setClosingPrs' | 'removeIssue' | 'removeComment'> {
  const dropLinks = db.prepare('DELETE FROM issue_pull_requests WHERE source = ? AND issue_node_id = ?');
  const link = db.prepare('INSERT INTO issue_pull_requests (source, issue_node_id, number, url, state, draft, checks) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const dropIssue = db.prepare('DELETE FROM issues WHERE source = ? AND node_id = ?');
  const dropComments = db.prepare('DELETE FROM comments WHERE source = ? AND issue_node_id = ?');
  const dropComment = db.prepare('DELETE FROM comments WHERE source = ? AND node_id = ?');
  const dropPull = db.prepare('DELETE FROM pulls WHERE source = ? AND node_id = ?');
  const dropReviews = db.prepare('DELETE FROM pull_reviews WHERE source = ? AND pull_node_id = ?');
  const dropChecks = db.prepare('DELETE FROM pull_checks WHERE source = ? AND pull_node_id = ?');
  return {
    // The links have their own write: a linked PR moving does not bump the issue's updated_at, so they live outside the replace rule
    setClosingPrs: (source, issueNodeId, prs) => inTransaction(db, () => {
      dropLinks.run(source, issueNodeId);
      for (const pr of prs) link.run(source, issueNodeId, pr.number, pr.url, pr.state, pr.draft === true ? 1 : 0, pr.checks ?? null);
    }),
    removeIssue: (source, nodeId) => inTransaction(db, () => {
      dropComments.run(source, nodeId);
      dropLinks.run(source, nodeId);
      dropReviews.run(source, nodeId);
      dropChecks.run(source, nodeId);
      dropPull.run(source, nodeId);
      dropIssue.run(source, nodeId);
    }),
    removeComment: (source, nodeId) => { dropComment.run(source, nodeId); },
  };
}

// The links of every row read in one query, instead of one per issue
function viewsOf(db: DatabaseSync): (source: string, rows: Row[]) => IssueView[] {
  const links = db.prepare('SELECT * FROM issue_pull_requests WHERE source = ? AND issue_node_id IN (SELECT value FROM json_each(?)) ORDER BY number');
  return (source, rows) => {
    const issues = rows.map(issueOf);
    const byIssue = new Map<string, ProjectPr[]>();
    for (const row of links.all(source, JSON.stringify(issues.map((i) => i.nodeId)))) {
      const id = text(row, 'issue_node_id');
      byIssue.set(id, [...(byIssue.get(id) ?? []), prOf(row)]);
    }
    return issues.map((issue) => ({ ...issue, pullRequests: byIssue.get(issue.nodeId) ?? [] }));
  };
}

function readsOf(db: DatabaseSync): Pick<ReadModel, 'scope' | 'issues' | 'issue' | 'issueByNode' | 'nodeIdOf' | 'comments' | 'nodeIds'> {
  const scope = db.prepare('SELECT cursor, etag, synced_at FROM sync_scopes WHERE source = ? AND repository = ? AND kind = ?');
  const issues = db.prepare("SELECT * FROM issues WHERE source = ? AND repository = ? AND kind = 'issue' AND state = ? ORDER BY updated_at DESC, number DESC LIMIT ?");
  const issue = db.prepare("SELECT * FROM issues WHERE source = ? AND repository = ? AND number = ? AND kind = 'issue'");
  const nodeId = db.prepare('SELECT node_id FROM issues WHERE source = ? AND repository = ? AND number = ?');
  const byNode = db.prepare('SELECT * FROM issues WHERE source = ? AND node_id = ?');
  const comments = db.prepare('SELECT * FROM comments WHERE source = ? AND issue_node_id = ? ORDER BY created_at');
  const ids = {
    issues: db.prepare('SELECT node_id FROM issues WHERE source = ? AND repository = ?'),
    comments: db.prepare('SELECT node_id FROM comments WHERE source = ? AND repository = ?'),
  };
  const views = viewsOf(db);
  return {
    scope: (source, repository, kind) => {
      const row = scope.get(source, repository, kind);
      return row === undefined ? undefined : { cursor: nullable(row, 'cursor'), etag: nullable(row, 'etag'), syncedAt: nullable(row, 'synced_at') };
    },
    issues: (source, repository, state, limit = NO_LIMIT) => views(source, issues.all(source, repository, state, limit)),
    issue: (source, repository, number) => {
      const row = issue.get(source, repository, number);
      return row === undefined ? undefined : views(source, [row])[0];
    },
    issueByNode: (source, nodeId) => {
      const row = byNode.get(source, nodeId);
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

function repoOf(row: Row): RepoRow {
  return {
    source: text(row, 'source'), repository: text(row, 'repository'), url: text(row, 'url'), canPush: Number(row.can_push) === 1,
    issuesEnabled: Number(row.issues_enabled) === 1, forkParent: nullable(row, 'fork_parent'), pushedAt: nullable(row, 'pushed_at'),
    methods: JSON.parse(text(row, 'methods')) as MergeMethod[],
  };
}

function repoTablesOf(db: DatabaseSync): Pick<ReadModel, 'setRepo' | 'repo' | 'setLabels' | 'labels'> {
  const upsert = db.prepare(UPSERT_REPO);
  const repo = db.prepare('SELECT * FROM repos WHERE source = ? AND repository = ?');
  const names = db.prepare('SELECT name FROM labels WHERE source = ? AND repository = ? ORDER BY name COLLATE NOCASE');
  const dropLabels = db.prepare('DELETE FROM labels WHERE source = ? AND repository = ?');
  const addLabel = db.prepare('INSERT INTO labels (source, repository, name) VALUES (?, ?, ?)');
  const labels = (source: string, repository: string): string[] => names.all(source, repository).map((row) => text(row, 'name'));
  return {
    // node:sqlite binds no boolean
    setRepo: (row) => written(upsert.run({ ...row, canPush: row.canPush ? 1 : 0, issuesEnabled: row.issuesEnabled ? 1 : 0, methods: JSON.stringify(row.methods) })),
    repo: (source, repository) => {
      const row = repo.get(source, repository);
      return row === undefined ? undefined : repoOf(row);
    },
    // Compared as sets first: an unchanged 200 writes nothing, so the round names no labels kind
    setLabels: (source, repository, wanted) => {
      const next = [...new Set(wanted)].sort();
      if (isDeepStrictEqual(next, [...labels(source, repository)].sort())) return false;
      inTransaction(db, () => {
        dropLabels.run(source, repository);
        for (const name of next) addLabel.run(source, repository, name);
      });
      return true;
    },
    labels,
  };
}

function countsOf(db: DatabaseSync): Pick<ReadModel, 'counts'> {
  const counts = db.prepare(COUNTS);
  return {
    counts: (source, repository) => {
      const row = counts.get(source, repository) ?? {}; // an aggregate always answers one row
      return {
        openIssues: Number(row.open_issues ?? 0), closedIssues: Number(row.closed_issues ?? 0), openPrs: Number(row.open_prs ?? 0),
        ...(typeof row.last === 'string' ? { lastUpdatedAt: row.last } : {}),
      };
    },
  };
}

// Each missing migration in its own transaction, with the version it reaches, so a crash between two leaves a file that resumes. #271: the usage
// store runs its own list through it; name is whose file it is, in the error
export function migrate(db: DatabaseSync, migrations: readonly string[], name = 'read model'): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  // a file of a newer Hive has tables this code cannot read: the read model rebuilds it, the usage store turns off (#271)
  if (!Number.isInteger(version) || version > migrations.length) throw new Error(`${name}: schema version ${version} is newer than ${migrations.length}`);
  for (const [index, sql] of migrations.entries()) {
    if (index < version) continue;
    inTransaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
}

// WAL keeps a -wal and a -shm beside the database: all three get the owner-only mode
export function restrict(path: string): void {
  for (const suffix of SIDE_FILES) if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, FILE_MODE);
}

function modelOf(db: DatabaseSync, now: () => number): ReadModel {
  const reads = readsOf(db);
  const repos = repoTablesOf(db);
  return {
    ...upsertsOf(db, now), ...removalsOf(db), ...reads, ...repos, ...countsOf(db), ...pullTablesOf(db), ...itemTablesOf(db, now),
    ...prDetailsOf(db, now, { comments: reads.comments, repo: repos.repo }),
    transaction: <T>(run: () => T): T => inTransaction(db, run), close: () => db.close(),
  };
}

// The handle is closed on any failure, statement preparation included, so the files can be deleted after it (Windows refuses an open one)
function modelAt(Database: Sqlite, path: string, migrations: readonly string[], now: () => number): ReadModel {
  // created owner-only before sqlite creates it, so no other account can open it in between
  if (path !== MEMORY) closeSync(openSync(path, 'a', FILE_MODE));
  const db = new Database(path);
  try {
    db.exec('PRAGMA journal_mode = WAL'); // a reader outside the daemon (the sqlite3 CLI) never blocks its writes
    migrate(db, migrations);
    if (path !== MEMORY) restrict(path);
    return modelOf(db, now);
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Opens, and creates on first use, the read model at `path`; `:memory:` keeps it in memory. node:sqlite is imported here, so only the
 * process that opens the model prints its ExperimentalWarning. A file it cannot open (not a database, a failed migration, a newer schema)
 * is deleted with its -wal and -shm and opened again once, answering `resync: true`: the model is a cache. A second failure throws. */
export async function openReadModel(path: string, options: OpenOptions = {}): Promise<{ db: ReadModel; resync: boolean }> {
  const { DatabaseSync: Database } = await import('node:sqlite');
  const open = (): ReadModel => modelAt(Database, path, options.migrations ?? MIGRATIONS, options.now ?? Date.now);
  try {
    return { db: open(), resync: false };
  } catch (first) {
    if (path !== MEMORY) for (const suffix of SIDE_FILES) rmSync(`${path}${suffix}`, { force: true });
    try {
      return { db: open(), resync: true };
    } catch (second) {
      // the first error is why the file was dropped: kept, so a failure that is not corruption (EACCES, a full disk) shows its cause
      throw new Error(`read model: cannot open ${path}`, { cause: { first, second } });
    }
  }
}
