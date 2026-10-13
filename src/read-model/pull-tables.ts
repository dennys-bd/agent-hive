import type { DatabaseSync } from 'node:sqlite';
import { prLink } from '../pull-requests.js';
import type { PrMergeState, PrReviewDecision, PrRow, PrState } from '../types.js';
import type { ReadModel } from './db.js';
import type { PullChecks, PullKey } from './rows.js';
import { nullable, type Row, text, written } from './sql.js';

// The pulls table (#186): each writer is an upsert of its own columns with the changed-row guard, so a quiet round writes nothing. Every read
// joins it to the PR rows of issues: a PR with no pulls row yet reads the defaults and never vanishes from the rows or the counts
const KEY_VALUES = '$source, $nodeId, $repository, $number';
const SET_FLAGS = `INSERT INTO pulls (source, node_id, repository, number, draft, merged_at) VALUES (${KEY_VALUES}, $draft, $mergedAt)
  ON CONFLICT (source, node_id) DO UPDATE SET draft = excluded.draft, merged_at = excluded.merged_at
  WHERE (excluded.draft, excluded.merged_at) IS NOT (pulls.draft, pulls.merged_at)`;
const SET_DECISION = `INSERT INTO pulls (source, node_id, repository, number, decision, read_at) VALUES (${KEY_VALUES}, $decision, $readAt)
  ON CONFLICT (source, node_id) DO UPDATE SET decision = excluded.decision, read_at = excluded.read_at
  WHERE (excluded.decision, excluded.read_at) IS NOT (pulls.decision, pulls.read_at)`;
const SET_SETTLED = `INSERT INTO pulls (source, node_id, repository, number, decision, read_at, merge_state, checks)
  VALUES (${KEY_VALUES}, $decision, $readAt, $mergeState, $checks)
  ON CONFLICT (source, node_id) DO UPDATE SET decision = excluded.decision, read_at = excluded.read_at, merge_state = excluded.merge_state,
    checks = excluded.checks
  WHERE (excluded.decision, excluded.read_at, excluded.merge_state, excluded.checks) IS NOT (pulls.decision, pulls.read_at, pulls.merge_state, pulls.checks)`;
const SET_POLL = `INSERT INTO pulls (source, node_id, repository, number, head_sha, merge_state, checks) VALUES (${KEY_VALUES}, $headSha, $mergeState, $checks)
  ON CONFLICT (source, node_id) DO UPDATE SET head_sha = excluded.head_sha, merge_state = excluded.merge_state, checks = excluded.checks
  WHERE (excluded.head_sha, excluded.merge_state, excluded.checks) IS NOT (pulls.head_sha, pulls.merge_state, pulls.checks)`;
const PR_ROWS = `FROM issues i LEFT JOIN pulls p ON p.source = i.source AND p.node_id = i.node_id
  WHERE i.source = $source AND i.repository = $repository AND i.kind = 'pr' AND ($author IS NULL OR i.author = $author COLLATE NOCASE)`; // GitHub logins ignore case
// merged is closed with merged_at; a PR with no pulls row has none, so it reads closed
const LIST_STATE = "CASE WHEN i.state = 'open' THEN 'open' WHEN p.merged_at IS NOT NULL THEN 'merged' ELSE 'closed' END";
const ROWS = `SELECT i.number, i.title, i.updated_at, ${LIST_STATE} AS list_state, p.draft, p.merge_state, p.checks, p.decision ${PR_ROWS}
  AND ${LIST_STATE} = $state ORDER BY i.updated_at DESC, i.number DESC LIMIT $limit`;
const COUNTS = `SELECT COUNT(*) FILTER (WHERE ${LIST_STATE} = 'open') AS open_count, COUNT(*) FILTER (WHERE ${LIST_STATE} = 'merged') AS merged_count,
  COUNT(*) FILTER (WHERE ${LIST_STATE} = 'closed') AS closed_count ${PR_ROWS}`;
const TO_READ = `SELECT i.node_id, i.number, i.state, i.updated_at ${PR_ROWS} AND (p.read_at IS NULL OR i.updated_at > p.read_at) ORDER BY i.number`;
const OPEN = `SELECT i.node_id, i.number, p.head_sha, p.merge_state ${PR_ROWS} AND i.state = 'open' ORDER BY i.number`;
// substr, not LIKE: a prefix is matched as written
const DROP_SCOPES = 'DELETE FROM sync_scopes WHERE source = $source AND repository = $repository AND substr(kind, 1, length($prefix)) = $prefix';
const NO_LIMIT = -1; // SQLite's LIMIT -1: every row
const MERGE_STATES: readonly PrMergeState[] = ['clean', 'unstable', 'hooks', 'conflicts', 'blocked', 'behind', 'draft', 'unknown'];
const CHECKS: readonly PullChecks[] = ['success', 'failure', 'pending', 'awaiting'];
const DECISIONS: readonly PrReviewDecision[] = ['approved', 'changes', 'pending'];
const LIST_STATES: readonly PrState[] = ['open', 'merged', 'closed'];

type PullTables = Pick<ReadModel, 'setPullFlags' | 'setPullRead' | 'setPullPoll' | 'removeScopes' | 'prs' | 'prCounts' | 'pullsToRead' | 'openPulls'>;

const mergeStateOf = (value: unknown): PrMergeState => MERGE_STATES.find((s) => s === value) ?? 'unknown';
// node:sqlite refuses a named parameter the statement lacks: only the key's four
const keyOf = (key: PullKey): Record<string, string | number> => ({ source: key.source, nodeId: key.nodeId, repository: key.repository, number: key.number });
const scoped = (source: string, repository: string, author: string | undefined): Record<string, string | null> => ({ source, repository, author: author ?? null });

// The stored values are the module's own writes; one outside its type reads as none
function prRowOf(repository: string, row: Row): PrRow {
  const number = Number(row.number);
  const checks = CHECKS.find((c) => c === row.checks);
  const decision = DECISIONS.find((d) => d === row.decision);
  return {
    url: prLink(repository, number), number, title: text(row, 'title'), state: LIST_STATES.find((s) => s === row.list_state) ?? 'closed',
    isDraft: row.draft === 1, mergeState: mergeStateOf(row.merge_state), updatedAt: text(row, 'updated_at'),
    ...(checks === undefined ? {} : { checks }), ...(decision === undefined ? {} : { decision }),
  };
}

function writesOf(db: DatabaseSync): Pick<PullTables, 'setPullFlags' | 'setPullRead' | 'setPullPoll' | 'removeScopes'> {
  const flags = db.prepare(SET_FLAGS);
  const decision = db.prepare(SET_DECISION);
  const settled = db.prepare(SET_SETTLED);
  const poll = db.prepare(SET_POLL);
  const dropScopes = db.prepare(DROP_SCOPES);
  return {
    // node:sqlite binds no boolean
    setPullFlags: (row) => written(flags.run({ ...keyOf(row), draft: row.draft ? 1 : 0, mergedAt: row.mergedAt })),
    setPullRead: (key, read) => (read.settled === undefined
      ? written(decision.run({ ...keyOf(key), decision: read.decision, readAt: read.readAt }))
      : written(settled.run({ ...keyOf(key), decision: read.decision, readAt: read.readAt, mergeState: read.settled.mergeState, checks: read.settled.checks }))),
    setPullPoll: (key, value) => written(poll.run({ ...keyOf(key), headSha: value.headSha, mergeState: value.mergeState, checks: value.checks })),
    removeScopes: (source, repository, prefix) => {
      dropScopes.run({ source, repository, prefix });
    },
  };
}

function readsOf(db: DatabaseSync): Pick<PullTables, 'prs' | 'prCounts' | 'pullsToRead' | 'openPulls'> {
  const rows = db.prepare(ROWS);
  const counts = db.prepare(COUNTS);
  const toRead = db.prepare(TO_READ);
  const open = db.prepare(OPEN);
  return {
    prs: (source, repository, state, filter = {}) =>
      rows.all({ ...scoped(source, repository, filter.author), state, limit: filter.limit ?? NO_LIMIT }).map((row) => prRowOf(repository, row)),
    prCounts: (source, repository, author) => {
      const row = counts.get(scoped(source, repository, author)) ?? {}; // an aggregate always answers one row
      return { open: Number(row.open_count ?? 0), merged: Number(row.merged_count ?? 0), closed: Number(row.closed_count ?? 0) };
    },
    pullsToRead: (source, repository, author) => toRead.all(scoped(source, repository, author)).map((row) => ({
      nodeId: text(row, 'node_id'), number: Number(row.number), isOpen: row.state === 'open', updatedAt: text(row, 'updated_at'),
    })),
    openPulls: (source, repository, author) => open.all(scoped(source, repository, author)).map((row) => ({
      nodeId: text(row, 'node_id'), number: Number(row.number), headSha: nullable(row, 'head_sha'), mergeState: mergeStateOf(row.merge_state),
    })),
  };
}

/** The pulls table's writes, the poll scopes' removal and the PR list's reads (#186), as db.ts's model spreads them. */
export const pullTablesOf = (db: DatabaseSync): PullTables => ({ ...writesOf(db), ...readsOf(db) });
