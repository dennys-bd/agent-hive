import { SUITE_FIELDS } from '../pr-checks.js';
import type { RepoRef } from '../repos/repositories.js';
import type { PrMergeState } from '../types.js';
import type { PullPart, ScopeKind } from './db.js';
import { pullFromRest, pullsFromGql, rollupOf, runsReading, statusReading, suitesReading, type PullGql } from './normalize.js';
import type { RefetchDeps } from './reconcile.js';
import { readAll } from './repo-scopes.js';
import type { OpenPull, PullToRead } from './rows.js';
import { EMPTY_REPORT, mergeReports, SyncStopped, throwIfStopped, type SyncDeps, type SyncReport } from './sync.js';
import { prAuthorOf } from './views.js';

/** The batch's cap (#186): GitHub looks up at most 100 nodes in one query. */
export const BATCH_SIZE = 100;
type CheckPart = Exclude<PullPart, 'pr'>;
const CHECK_PARTS: readonly CheckPart[] = ['runs', 'status', 'suites'];
const CHECK_PATHS: Record<CheckPart, string> = { runs: 'check-runs', status: 'status', suites: 'check-suites' };
const READINGS: Record<CheckPart, (bodies: unknown[]) => string | null> = { runs: runsReading, status: statusReading, suites: suitesReading };
// What the list read of a PR over GraphQL before (#758, #854)
const PULL_FIELDS = 'id reviewDecision mergeStateStatus '
  + `headCommit: commits(last: 1) { nodes { commit { ${SUITE_FIELDS} statusCheckRollup { state } } } }`;

export const pullPath = (repository: string, number: number): string => `repos/${repository}/pulls/${number}`;
export const checkPath = (repository: string, sha: string, part: CheckPart): string => `repos/${repository}/commits/${sha}/${CHECK_PATHS[part]}?per_page=100`;
const partKind = (number: number, part: PullPart): ScopeKind => `pull/${number}/${part}` as const;

/** The batch's query for `count` PRs (#186): one aliased node lookup each, since a Gql variable is a scalar, never a list. */
export function batchQuery(count: number): string {
  const at = Array.from({ length: count }, (_, i) => i);
  return `query(${at.map((i) => `$id${i}: ID!`).join(', ')}) { ${at.map((i) => `p${i}: node(id: $id${i}) { ... on PullRequest { ${PULL_FIELDS} } }`).join(' ')} }`;
}

/** What the round's PR part did (#186): what it stored, and every failure; one PR's failure never stops the others. */
export interface PullsResult { report: SyncReport; errors: unknown[] }

// One transaction per call: each PR's decision and read_at; a PR that is not open also gets its merge state and checks, which on an open PR
// only the poll writes, so the two rollups never flip the value. A PR the answer lacks (deleted) keeps its read_at
function storeBatch(deps: SyncDeps, repository: string, due: PullToRead[], read: PullGql[]): boolean {
  const byId = new Map(read.map((pr) => [pr.nodeId, pr]));
  return deps.db.transaction(() => due.reduce((wrote, pr) => {
    const node = byId.get(pr.nodeId);
    if (node === undefined) return wrote;
    const key = { source: deps.source, nodeId: pr.nodeId, repository, number: pr.number };
    const settled = pr.isOpen ? {} : { settled: { mergeState: node.mergeState, checks: node.checks } };
    return deps.db.setPullRead(key, { decision: node.decision, readAt: pr.updatedAt, ...settled }) || wrote;
  }, false));
}

// The GraphQL batch (#186), BATCH_SIZE ids per call. A failure, the rate limit included, ends it: what it did not store keeps its read_at,
// so the next round asks again. It runs under the round's REST backoff only
async function readBatch(deps: RefetchDeps, repository: string, due: PullToRead[]): Promise<PullsResult> {
  let report = EMPTY_REPORT;
  for (let at = 0; at < due.length; at += BATCH_SIZE) {
    const chunk = due.slice(at, at + BATCH_SIZE);
    try {
      throwIfStopped(deps);
      const answer = await deps.gql(batchQuery(chunk.length), Object.fromEntries(chunk.map((pr, i) => [`id${i}`, pr.nodeId])));
      if (storeBatch(deps, repository, chunk, pullsFromGql(answer))) report = mergeReports(report, { kinds: ['pulls'], requests: { 200: 0, 304: 0 } });
    } catch (err) {
      if (err instanceof SyncStopped) throw err;
      return { report, errors: [err] };
    }
  }
  return { report, errors: [] };
}

interface Conditional { bodies?: unknown[]; etag: string | null; requests: SyncReport['requests'] }
interface PartRead extends Conditional { part: PullPart; reading: string | null }

// One conditional read through repo-scopes' readAll; a 304 keeps the ETag it was sent
async function conditional(deps: SyncDeps, path: string, etag: string | null): Promise<Conditional> {
  const read = await readAll(deps, path, etag);
  if (read === undefined) return { etag, requests: { 200: 0, 304: 1 } };
  return { bodies: read.bodies, etag: read.etag, requests: { 200: read.bodies.length, 304: 0 } };
}

// The head the checks are read at: a 200's, or on a 304 the stored one, which a 304 implies, since no ETag is sent without one
function headOf(pr: OpenPull, read: Conditional): { headSha: string; mergeState: PrMergeState } {
  if (read.bodies !== undefined) return pullFromRest(read.bodies[0]);
  if (pr.headSha === null) throw new Error(`read model: pull ${pr.number} answered 304 with no head stored`);
  return { headSha: pr.headSha, mergeState: pr.mergeState };
}

// The three check parts at the head. A moved head names other paths, so their old ETags are never sent; a 304 keeps the reading the part's
// scope stored beside its ETag
async function readChecks(deps: SyncDeps, repository: string, pr: OpenPull, headSha: string): Promise<PartRead[]> {
  const isMoved = headSha !== pr.headSha;
  const reads: PartRead[] = [];
  for (const part of CHECK_PARTS) {
    const saved = isMoved ? undefined : deps.db.scope(deps.source, repository, partKind(pr.number, part));
    const read = await conditional(deps, checkPath(repository, headSha, part), saved?.etag ?? null);
    reads.push({ ...read, part, reading: read.bodies === undefined ? (saved?.cursor ?? null) : READINGS[part](read.bodies) });
  }
  return reads;
}

// One open PR (#186): pulls/{n}, then its head's runs, status and suites, each conditional. Nothing is written until all four answered, so
// a failure leaves the PR's scopes and row as they were; a part's scope is written only on a 200, so a quiet round writes nothing
async function pollPull(deps: SyncDeps, repository: string, pr: OpenPull): Promise<SyncReport> {
  const { db, source } = deps;
  const etag = pr.headSha === null ? null : (db.scope(source, repository, partKind(pr.number, 'pr'))?.etag ?? null);
  const pull = await conditional(deps, pullPath(repository, pr.number), etag);
  const head = headOf(pr, pull);
  const checks = await readChecks(deps, repository, pr, head.headSha);
  const parts: PartRead[] = [{ ...pull, part: 'pr', reading: null }, ...checks];
  const syncedAt = deps.now().toISOString();
  const [runs, status, suites] = checks.map((read) => read.reading);
  const wrote = db.transaction(() => {
    for (const read of parts) {
      if (read.bodies !== undefined) db.setScope(source, repository, partKind(pr.number, read.part), { cursor: read.reading, etag: read.etag, syncedAt });
    }
    return db.setPullPoll({ source, nodeId: pr.nodeId, repository, number: pr.number }, { ...head, checks: rollupOf(runs, status, suites) });
  });
  const requests = parts.reduce((sum, read) => ({ 200: sum[200] + read.requests[200], 304: sum[304] + read.requests[304] }), { 200: 0, 304: 0 });
  return { kinds: wrote ? ['pulls'] : [], requests };
}

/** The round's PR part (#186), after the issue scopes: the GraphQL batch of the PRs whose updated_at moved, the REST poll of each open PR,
 * then the poll scopes of the PRs that stopped being open dropped (a close bumps updated_at, so the batch's list names them; their rows stay
 * as last read). On an original only the login's PRs. A failure is collected and the rest still runs; a stop throws SyncStopped. */
export async function syncPulls(deps: RefetchDeps, ref: RepoRef): Promise<PullsResult> {
  const { db, source } = deps;
  const { repository } = ref;
  const author = prAuthorOf(source, ref);
  const due = db.pullsToRead(source, repository, author);
  const batch = await readBatch(deps, repository, due);
  let report = batch.report;
  const errors = [...batch.errors];
  for (const pr of db.openPulls(source, repository, author)) {
    try {
      report = mergeReports(report, await pollPull(deps, repository, pr));
    } catch (err) {
      if (err instanceof SyncStopped) throw err;
      errors.push(err);
    }
  }
  for (const pr of due) if (!pr.isOpen) db.removeScopes(source, repository, `pull/${pr.number}/`);
  return { report, errors };
}
