import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { PrCheck } from '../types.js';
import type { ReadModel } from './db.js';
import { keyOf, pullOf } from './pull-tables.js';
import type { CheckRow, ReviewRow } from './rows.js';
import { inTransaction, issueOf, nullable, paramOf, type Row, stamp, text, upsertSql, written } from './sql.js';

// A PR page's own rows (#187): its reviews, its head's checks, and what pulls/{n} and the batch tell beyond the list. Each pulls writer
// upserts its own columns with the changed-row guard, as pull-tables.ts's do, so a quiet round writes nothing
const KEY_VALUES = '$source, $nodeId, $repository, $number';
const PAGE_COLUMNS = ['head_ref', 'base_ref', 'head_owner', 'base_owner', 'commits', 'additions', 'deletions', 'requested'];
const REVIEW_COLUMNS = ['source', 'node_id', 'pull_node_id', 'repository', 'author', 'state', 'body', 'submitted_at'];
const CHECK_STATES: readonly PrCheck['state'][] = ['success', 'failure', 'pending'];
const REVIEW_STATES: readonly ReviewRow['state'][] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];

type PrDetails = Pick<ReadModel, 'setPullPage' | 'setPullChecks' | 'setPullAwaiting' | 'setPullCloses' | 'upsertReview' | 'prPage'>;

// One writer's statement: the key and `columns`, written only when one of them changed
function pullUpsert(columns: readonly string[]): string {
  const list = (prefix: string): string => columns.map((c) => `${prefix}${c}`).join(', ');
  return `INSERT INTO pulls (source, node_id, repository, number, ${columns.join(', ')}) VALUES (${KEY_VALUES}, ${columns.map((c) => `$${paramOf(c)}`).join(', ')})
  ON CONFLICT (source, node_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}
  WHERE (${list('excluded.')}) IS NOT (${list('pulls.')})`;
}

// The stored values are the module's own writes; one outside its type reads as the mildest
const checkOf = (row: Row): CheckRow => ({
  name: text(row, 'name'), state: CHECK_STATES.find((s) => s === row.state) ?? 'pending', url: nullable(row, 'url'), startedAt: nullable(row, 'started_at'), at: nullable(row, 'at'),
});
const reviewOf = (row: Row): ReviewRow => ({
  source: text(row, 'source'), nodeId: text(row, 'node_id'), pullNodeId: text(row, 'pull_node_id'), repository: text(row, 'repository'),
  author: nullable(row, 'author'), state: REVIEW_STATES.find((s) => s === row.state) ?? 'COMMENTED', body: text(row, 'body'), submittedAt: text(row, 'submitted_at'),
});

function writesOf(db: DatabaseSync, now: () => number): Pick<PrDetails, 'setPullPage' | 'setPullAwaiting' | 'setPullCloses' | 'upsertReview'> {
  const page = db.prepare(pullUpsert(PAGE_COLUMNS));
  const awaiting = db.prepare(pullUpsert(['awaiting']));
  const closes = db.prepare(pullUpsert(['closes']));
  const review = db.prepare(upsertSql('pull_reviews', REVIEW_COLUMNS, 'submitted_at'));
  return {
    // node:sqlite refuses a named parameter the statement lacks: each field by name, the lists as JSON
    setPullPage: (key, value) => written(page.run({
      ...keyOf(key), headRef: value.headRef, baseRef: value.baseRef, headOwner: value.headOwner, baseOwner: value.baseOwner,
      commits: value.commits, additions: value.additions, deletions: value.deletions, requested: JSON.stringify(value.requested),
    })),
    setPullAwaiting: (key, workflows) => written(awaiting.run({ ...keyOf(key), awaiting: JSON.stringify(workflows) })),
    setPullCloses: (key, issues) => written(closes.run({ ...keyOf(key), closes: JSON.stringify(issues) })),
    // A review has no updated_at: submitted_at stands in, so on a tie the window alone keeps a write's answer from a sync read before it
    upsertReview: (row, origin) => written(review.run({ ...row, ...stamp(now(), origin) })),
  };
}

function checksOf(db: DatabaseSync): Pick<PrDetails, 'setPullChecks'> & { checks(source: string, pullNodeId: string): CheckRow[] } {
  const read = db.prepare('SELECT name, state, url, started_at, at FROM pull_checks WHERE source = ? AND pull_node_id = ? ORDER BY position');
  const drop = db.prepare('DELETE FROM pull_checks WHERE source = ? AND pull_node_id = ?');
  const add = db.prepare('INSERT INTO pull_checks (source, pull_node_id, position, name, state, url, started_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const checks = (source: string, pullNodeId: string): CheckRow[] => read.all(source, pullNodeId).map(checkOf);
  return {
    checks,
    // Compared first, as setLabels: an identical set writes nothing, so a quiet round names no pulls kind
    setPullChecks: (key, rows) => {
      if (isDeepStrictEqual(checks(key.source, key.nodeId), rows)) return false;
      inTransaction(db, () => {
        drop.run(key.source, key.nodeId);
        for (const [position, row] of rows.entries()) add.run(key.source, key.nodeId, position, row.name, row.state, row.url, row.startedAt, row.at);
      });
      return true;
    },
  };
}

/** The page's writers and its read (#187), as db.ts's model spreads them. The read needs no transaction: node:sqlite is synchronous and this
 * process is the only writer, so no write lands between its queries. */
export function prDetailsOf(db: DatabaseSync, now: () => number, reads: Pick<ReadModel, 'comments' | 'repo'>): PrDetails {
  const issue = db.prepare("SELECT * FROM issues WHERE source = ? AND repository = ? AND number = ? AND kind = 'pr'");
  const pull = db.prepare('SELECT * FROM pulls WHERE source = ? AND node_id = ?');
  const reviews = db.prepare('SELECT * FROM pull_reviews WHERE source = ? AND pull_node_id = ? ORDER BY submitted_at, node_id');
  const { checks, setPullChecks } = checksOf(db);
  return {
    ...writesOf(db, now), setPullChecks,
    prPage: (source, repository, number) => {
      const row = issue.get(source, repository, number);
      if (row === undefined) return undefined;
      const found = issueOf(row);
      const pulled = pull.get(source, found.nodeId);
      return {
        issue: found, pull: pulled === undefined ? undefined : pullOf(pulled), reviews: reviews.all(source, found.nodeId).map(reviewOf),
        comments: reads.comments(source, found.nodeId), checks: checks(source, found.nodeId), repo: reads.repo(source, repository),
      };
    },
  };
}
