import { SUITE_FIELDS } from '../pr-checks.js';
import { CLOSES_FIELDS } from '../pr-github.js';
import type { RepoRef } from '../repos/repositories.js';
import type { PrMergeState } from '../types.js';
import type { PullPart, ScopeKind } from './db.js';
import { awaitingFromRest, checkItemsFromRest, pullFromRest, pullPageFromRest, pullsFromGql, reviewsFromRest, rollupOf, runsReading, statusReading, suitesReading, type PullGql } from './normalize.js';
import type { RefetchDeps } from './reconcile.js';
import { readAll } from './repo-scopes.js';
import type { OpenPull, PullToRead } from './rows.js';
import { EMPTY_REPORT, mergeReports, SyncStopped, throwIfStopped, type SyncDeps, type SyncReport } from './sync.js';
import { prAuthorOf } from './views.js';

/** The batch's cap (#186): GitHub looks up at most 100 nodes in one query. */
export const BATCH_SIZE = 100;
type CheckPart = Exclude<PullPart, 'pr' | 'reviews'>;
const CHECK_PARTS: readonly CheckPart[] = ['runs', 'status', 'suites'];
const CHECK_PATHS: Record<CheckPart, string> = { runs: 'check-runs', status: 'status', suites: 'check-suites' };
const READINGS: Record<CheckPart, (bodies: unknown[]) => string | null> = { runs: runsReading, status: statusReading, suites: suitesReading };
// What the list read of a PR over GraphQL before (#758, #854), and the issues it closes, which REST has not (#187)
const PULL_FIELDS = `id reviewDecision mergeStateStatus ${CLOSES_FIELDS} `
  + `headCommit: commits(last: 1) { nodes { commit { ${SUITE_FIELDS} statusCheckRollup { state } } } }`;

export const pullPath = (repository: string, number: number): string => `repos/${repository}/pulls/${number}`;
export const checkPath = (repository: string, sha: string, part: CheckPart): string => `repos/${repository}/commits/${sha}/${CHECK_PATHS[part]}?per_page=100`;
export const reviewsPath = (repository: string, number: number): string => `repos/${repository}/pulls/${number}/reviews?per_page=100`;
// sha is pullFromRest's, checked as a SHA before any path takes it
export const awaitingPath = (repository: string, sha: string): string => `repos/${repository}/actions/runs?head_sha=${sha}&status=action_required&per_page=100`;
const plus = (a: SyncReport['requests'], b: SyncReport['requests']): SyncReport['requests'] => ({ 200: a[200] + b[200], 304: a[304] + b[304] });
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
    const read = deps.db.setPullRead(key, { decision: node.decision, readAt: pr.updatedAt, ...settled });
    const closes = deps.db.setPullCloses(key, node.closes);
    return read || closes || wrote;
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

// The ETag a part is asked with: pulls/{n}'s only once a head is stored, since a 304 there needs one
function savedEtag(deps: SyncDeps, repository: string, pr: OpenPull, part: 'pr' | 'reviews'): string | null {
  if (part === 'pr' && pr.headSha === null) return null;
  return deps.db.scope(deps.source, repository, partKind(pr.number, part))?.etag ?? null;
}

const isItemPart = (read: PartRead): read is PartRead & { part: 'runs' | 'status' } => read.part === 'runs' || read.part === 'status';

// The check items come from two parts with their own ETags (#187): when one answered 200 and the other 304, the other is read again without
// its ETag, so the items are stored whole from both bodies. One more request, and only when a check changed
async function completeItems(deps: SyncDeps, repository: string, sha: string, reads: PartRead[]): Promise<PartRead[]> {
  if (!reads.some((read) => isItemPart(read) && read.bodies !== undefined)) return reads;
  const completed: PartRead[] = [];
  for (const read of reads) {
    if (!isItemPart(read) || read.bodies !== undefined) {
      completed.push(read);
      continue;
    }
    const again = await conditional(deps, checkPath(repository, sha, read.part), null);
    const reading = again.bodies === undefined ? read.reading : READINGS[read.part](again.bodies);
    completed.push({ ...again, part: read.part, reading, requests: plus(read.requests, again.requests) });
  }
  return completed;
}

// The workflows awaiting approval (#187): read only on a suites 200 that awaits; a 304 keeps the stored names (undefined), any other 200 clears them
async function awaitingRead(deps: SyncDeps, repository: string, sha: string, checks: PartRead[]): Promise<{ names?: string[]; requests: SyncReport['requests'] }> {
  const suites = checks.find((read) => read.part === 'suites');
  const none = { 200: 0, 304: 0 };
  if (suites?.bodies === undefined) return { requests: none };
  if (suites.reading !== 'awaiting') return { names: [], requests: none };
  const read = await conditional(deps, awaitingPath(repository, sha), null);
  return { ...(read.bodies === undefined ? {} : { names: awaitingFromRest(read.bodies) }), requests: read.requests };
}

interface PollRead { head: { headSha: string; mergeState: PrMergeState }; parts: PartRead[]; awaiting?: string[] }

// One transaction: each part's scope on a 200, then the poll's columns, the page, the items (only from both item bodies), the awaiting names
// and the reviews. Every writer runs; whether any wrote
function storePoll(deps: SyncDeps, repository: string, pr: OpenPull, read: PollRead): boolean {
  const { db, source } = deps;
  const key = { source, nodeId: pr.nodeId, repository, number: pr.number };
  const syncedAt = deps.now().toISOString();
  for (const part of read.parts) if (part.bodies !== undefined) db.setScope(source, repository, partKind(pr.number, part.part), { cursor: part.reading, etag: part.etag, syncedAt });
  const partOf = (name: PullPart): PartRead | undefined => read.parts.find((part) => part.part === name);
  const [pull, runs, status, reviews] = (['pr', 'runs', 'status', 'reviews'] as const).map((name) => partOf(name)?.bodies);
  const [runsReading, statusReading, suitesReading] = CHECK_PARTS.map((name) => partOf(name)?.reading ?? null);
  const wrote = [
    db.setPullPoll(key, { ...read.head, checks: rollupOf(runsReading, statusReading, suitesReading) }),
    pull !== undefined && db.setPullPage(key, pullPageFromRest(pull[0])),
    runs !== undefined && status !== undefined && db.setPullChecks(key, checkItemsFromRest(runs, status)),
    read.awaiting !== undefined && db.setPullAwaiting(key, read.awaiting),
    ...(reviews === undefined ? [] : reviewsFromRest(source, repository, pr.nodeId, reviews).map((row) => db.upsertReview(row, 'sync'))),
  ];
  return wrote.includes(true);
}

// One PR (#186, #187): pulls/{n}, its head's runs, status and suites, the awaiting names when a suite awaits, and its reviews, each
// conditional. Nothing is written until every read answered, so a failure leaves the PR's scopes and rows as they were
async function pollPull(deps: SyncDeps, repository: string, pr: OpenPull): Promise<SyncReport> {
  const pull = await conditional(deps, pullPath(repository, pr.number), savedEtag(deps, repository, pr, 'pr'));
  const head = headOf(pr, pull);
  const checks = await completeItems(deps, repository, head.headSha, await readChecks(deps, repository, pr, head.headSha));
  const awaiting = await awaitingRead(deps, repository, head.headSha, checks);
  const reviews = await conditional(deps, reviewsPath(repository, pr.number), savedEtag(deps, repository, pr, 'reviews'));
  const parts: PartRead[] = [{ ...pull, part: 'pr', reading: null }, ...checks, { ...reviews, part: 'reviews', reading: null }];
  const wrote = deps.db.transaction(() => storePoll(deps, repository, pr, { head, parts, ...(awaiting.names === undefined ? {} : { awaiting: awaiting.names }) }));
  const requests = [...parts.map((part) => part.requests), awaiting.requests].reduce(plus, { 200: 0, 304: 0 });
  return { kinds: wrote ? ['pulls'] : [], requests };
}

/** One PR's poll for its page's refetch (#187), open or not; none when the model holds no PR at that number. */
export async function pollOne(deps: SyncDeps, repository: string, number: number): Promise<SyncReport> {
  throwIfStopped(deps);
  const pr = deps.db.pullAt(deps.source, repository, number);
  return pr === undefined ? EMPTY_REPORT : pollPull(deps, repository, pr);
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
