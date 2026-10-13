import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import { syncRepository } from '../../src/read-model/loop.js';
import { pullFlagsFromRest, pullFromRest, pullsFromGql, rollupOf, runsReading, statusReading, suitesReading, WireError } from '../../src/read-model/normalize.js';
import { BATCH_SIZE, checkPath, pullPath, syncPulls } from '../../src/read-model/pulls.js';
import { reconcile, refetchIssue } from '../../src/read-model/reconcile.js';
import { labelsPath, repoPath } from '../../src/read-model/repo-scopes.js';
import type { RestGet } from '../../src/read-model/rest.js';
import type { PullFlags } from '../../src/read-model/rows.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import { scopePath, syncScope } from '../../src/read-model/sync.js';
import type { RepoRef } from '../../src/repos/repositories.js';
import type { Gql } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';
import {
  fakeRest, HEAD, issueRow, NO_GQL, NOW, ok, OTHER_SOURCE, prIssueRow, pullKey, REF, REPO, REST_REPO, restIssue, restPr, SOURCE, T1, T2, T3, tempModel,
} from './fixtures.js';

const memory = async (): Promise<ReadModel> => (await openReadModel(':memory:')).db;
const flags = (n: number, draft: boolean, mergedAt: string | null): PullFlags => ({ ...pullKey(n), draft, mergedAt });
const LINK = 'https://github.com/acme/hive/pull/';

test('migration 3 on a version-2 file creates pulls and clears the issues scopes\' cursor and ETag, keeping synced_at (#186)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  // by hand: the model prepares the pulls statements at open, so one opened at version 2 could not
  const raw = new DatabaseSync(path);
  raw.exec(`${MIGRATIONS[0]} ${MIGRATIONS[1]} PRAGMA user_version = 2;`);
  const scope = raw.prepare('INSERT INTO sync_scopes (source, repository, kind, cursor, etag, synced_at) VALUES (?, ?, ?, ?, ?, ?)');
  scope.run(SOURCE, REPO, 'issues', T1, 'EI', T2);
  scope.run(SOURCE, REPO, 'comments', T1, 'EC', T2);
  raw.close();
  const { db, resync } = await openReadModel(path);
  t.after(() => db.close());
  assert.equal(resync, false);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: null, etag: null, syncedAt: T2 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'comments'), { cursor: T1, etag: 'EC', syncedAt: T2 });
  assert.equal(db.setPullFlags(flags(7, false, null)), true);
});

test('the list joins pulls to the PR rows: open, merged and closed by merged_at, newest first, capped by limit; a PR with no pulls row lists with the defaults; another source sees none (#186)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T2), 'sync');
  db.upsertIssue(prIssueRow(8, T3), 'sync'); // no pulls row yet
  db.upsertIssue(prIssueRow(5, T1, { state: 'closed', closedAt: T1 }), 'sync');
  db.upsertIssue(prIssueRow(4, T1, { state: 'closed', closedAt: T1 }), 'sync'); // closed with no pulls row: closed, never merged
  db.upsertIssue(issueRow(1, T3, { state: 'open' }), 'sync'); // an issue is never a PR row
  db.setPullFlags(flags(7, true, null));
  db.setPullFlags(flags(5, false, T1));
  assert.deepEqual(db.prs(SOURCE, REPO, 'open'), [
    { url: `${LINK}8`, number: 8, title: 'T8', state: 'open', isDraft: false, mergeState: 'unknown', updatedAt: T3 },
    { url: `${LINK}7`, number: 7, title: 'T7', state: 'open', isDraft: true, mergeState: 'unknown', updatedAt: T2 },
  ]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'merged').map((r) => [r.number, r.state]), [[5, 'merged']]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'closed').map((r) => [r.number, r.state]), [[4, 'closed']]);
  assert.deepEqual(db.prCounts(SOURCE, REPO), { open: 2, merged: 1, closed: 1 });
  assert.deepEqual(db.prs(SOURCE, REPO, 'open', { limit: 1 }).map((r) => r.number), [8]);
  assert.deepEqual([db.prs(OTHER_SOURCE, REPO, 'open'), db.prCounts(OTHER_SOURCE, REPO)], [[], { open: 0, merged: 0, closed: 0 }]);
});

test('each pulls writer sets only its own columns and writes only on a change; pullsToRead follows updated_at past read_at (#186)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T2), 'sync');
  assert.deepEqual(db.pullsToRead(SOURCE, REPO), [{ nodeId: 'PR_7', number: 7, isOpen: true, updatedAt: T2 }], 'never read');
  assert.deepEqual([db.setPullFlags(flags(7, false, null)), db.setPullFlags(flags(7, false, null))], [true, false]);
  const poll = { headSha: HEAD, mergeState: 'clean', checks: 'failure' } as const;
  assert.deepEqual([db.setPullPoll(pullKey(7), poll), db.setPullPoll(pullKey(7), poll)], [true, false]);
  assert.equal(db.setPullRead(pullKey(7), { decision: 'approved', readAt: T2 }), true);
  const [read] = db.prs(SOURCE, REPO, 'open');
  assert.deepEqual([read?.checks, read?.mergeState, read?.decision], ['failure', 'clean', 'approved'], 'the decision alone leaves the poll\'s columns');
  assert.deepEqual(db.pullsToRead(SOURCE, REPO), [], 'read at its updated_at');
  db.upsertIssue(prIssueRow(7, T3, { state: 'closed', closedAt: T3 }), 'sync');
  assert.deepEqual(db.pullsToRead(SOURCE, REPO), [{ nodeId: 'PR_7', number: 7, isOpen: false, updatedAt: T3 }]);
  assert.equal(db.setPullRead(pullKey(7), { decision: null, readAt: T3, settled: { mergeState: 'unknown', checks: null } }), true);
  const [settled] = db.prs(SOURCE, REPO, 'closed');
  assert.deepEqual([settled?.checks, settled?.mergeState, settled?.decision], [undefined, 'unknown', undefined]);
  assert.deepEqual(db.openPulls(SOURCE, REPO), []);
});

test('openPulls lists the open PRs with what the poll stored; an author filter keeps one login\'s PRs in every read (#186)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T1), 'sync'); // bia's
  db.upsertIssue(prIssueRow(9, T1, { author: 'caio' }), 'sync');
  db.setPullPoll(pullKey(7), { headSha: HEAD, mergeState: 'behind', checks: null });
  assert.deepEqual(db.openPulls(SOURCE, REPO), [
    { nodeId: 'PR_7', number: 7, headSha: HEAD, mergeState: 'behind' }, { nodeId: 'PR_9', number: 9, headSha: null, mergeState: 'unknown' },
  ]);
  assert.deepEqual(db.openPulls(SOURCE, REPO, 'bia').map((pr) => pr.number), [7]);
  assert.deepEqual(db.pullsToRead(SOURCE, REPO, 'bia').map((pr) => pr.number), [7]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'open', { author: 'bia' }).map((r) => r.number), [7]);
  assert.deepEqual(db.prCounts(SOURCE, REPO, 'bia'), { open: 1, merged: 0, closed: 0 });
});

test('removeScopes drops one PR\'s poll scopes only; removeIssue drops its pulls row (#186)', async () => {
  const db = await memory();
  for (const kind of ['pull/7/pr', 'pull/7/runs', 'pull/70/pr'] as const) db.setScope(SOURCE, REPO, kind, { cursor: null, etag: 'E', syncedAt: T1 });
  db.removeScopes(SOURCE, REPO, 'pull/7/');
  assert.deepEqual([db.scope(SOURCE, REPO, 'pull/7/pr'), db.scope(SOURCE, REPO, 'pull/7/runs'), db.scope(SOURCE, REPO, 'pull/70/pr')?.etag], [undefined, undefined, 'E']);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullFlags(flags(7, true, null));
  db.removeIssue(SOURCE, 'PR_7');
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  assert.equal(db.prs(SOURCE, REPO, 'open')[0]?.isDraft, false, 'the old flags left with the row');
});

test('pullFlagsFromRest reads a PR item\'s draft and merged_at; an issue item has none (#186)', () => {
  assert.equal(pullFlagsFromRest(SOURCE, REPO, restIssue(1, T1)), undefined);
  assert.deepEqual(pullFlagsFromRest(SOURCE, REPO, restPr(5, T2, T2, { draft: true })), { source: SOURCE, nodeId: 'PR_5', repository: REPO, number: 5, draft: true, mergedAt: T2 });
});

test('pullFromRest reads the head SHA and mergeable_state as GraphQL\'s merge state; a head that is no SHA throws (#186)', () => {
  const pull = (state: unknown, sha = HEAD): Record<string, unknown> => ({ number: 7, head: { sha, ref: 'feature' }, mergeable_state: state });
  assert.deepEqual(pullFromRest(pull('has_hooks')), { headSha: HEAD, mergeState: 'hooks' });
  const states = ['dirty', 'clean', 'unstable', 'blocked', 'behind', 'draft', 'unknown', 'new_value', null];
  assert.deepEqual(states.map((s) => pullFromRest(pull(s)).mergeState), ['conflicts', 'clean', 'unstable', 'blocked', 'behind', 'draft', 'unknown', 'unknown', 'unknown']);
  assert.throws(() => pullFromRest(pull('clean', '../../x')), WireError);
});

test('the rollup: failure beats pending beats success across the runs and the status; awaiting only when nothing ran; none when nothing ran (#186)', () => {
  const run = (status: string, conclusion: string | null): Record<string, unknown> => ({ name: 'test', status, conclusion });
  const runs = (...items: unknown[]): unknown[] => [{ total_count: items.length, check_runs: items }];
  assert.equal(runsReading(runs(run('completed', 'success'), run('in_progress', null))), 'pending');
  assert.equal(runsReading(runs(run('completed', 'success'), run('completed', 'timed_out'))), 'failure');
  assert.equal(runsReading(runs(run('completed', 'skipped'))), 'success');
  assert.equal(runsReading(runs()), null);
  assert.equal(statusReading([{ state: 'pending', statuses: [] }]), null, 'GitHub answers pending with no context');
  assert.equal(statusReading([{ state: 'failure', statuses: [{ context: 'ci', state: 'error' }] }]), 'failure');
  const suite = (slug: string, conclusion: string): Record<string, unknown> => ({ conclusion, app: { slug } });
  assert.equal(suitesReading([{ check_suites: [suite('github-actions', 'action_required')] }]), 'awaiting');
  assert.equal(suitesReading([{ check_suites: [suite('other-app', 'action_required'), suite('github-actions', 'success')] }]), null);
  assert.deepEqual(
    [rollupOf('success', 'failure', null), rollupOf('pending', 'success', 'awaiting'), rollupOf('success', null, null), rollupOf(null, null, 'awaiting'), rollupOf(null, null, null)],
    ['failure', 'pending', 'success', 'awaiting', null],
  );
});

test('pullsFromGql reads each aliased node\'s id, decision, merge state and checks; a deleted PR\'s null node is skipped (#186)', () => {
  const node = { id: 'PR_7', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'DIRTY', headCommit: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } };
  const suites = { nodes: [{ conclusion: 'ACTION_REQUIRED', app: { slug: 'github-actions' }, workflowRun: null }] };
  const waiting = { id: 'PR_8', reviewDecision: null, mergeStateStatus: 'UNKNOWN', headCommit: { nodes: [{ commit: { statusCheckRollup: null, checkSuites: suites } }] } };
  assert.deepEqual(pullsFromGql({ p0: node, p1: null, p2: waiting }), [
    { nodeId: 'PR_7', decision: 'changes', mergeState: 'conflicts', checks: 'success', closes: [] },
    { nodeId: 'PR_8', decision: null, mergeState: 'unknown', checks: 'awaiting', closes: [] },
  ]);
  assert.throws(() => pullsFromGql(null), WireError);
});

test('the issues scope writes draft and merged_at for its PR items and reports pulls; the same page again writes nothing (#186)', async () => {
  const db = await memory();
  const page = [restIssue(1, T1), restPr(7, T1, null, { draft: true }), restPr(5, T2, T2)];
  const first = await syncScope({ db, rest: fakeRest([ok(page, { etag: 'E1' })]).rest, source: SOURCE, now: NOW }, REPO, 'issues');
  assert.deepEqual(first.kinds, ['issues', 'pulls']);
  assert.deepEqual(db.prs(SOURCE, REPO, 'open').map((r) => [r.number, r.isDraft]), [[7, true]]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'merged').map((r) => r.number), [5]);
  db.setScope(SOURCE, REPO, 'issues', { cursor: null, etag: null, syncedAt: null }); // the same page read again from the start
  const again = await syncScope({ db, rest: fakeRest([ok(page)]).rest, source: SOURCE, now: NOW }, REPO, 'issues');
  assert.deepEqual(again.kinds, []);
});

test('a PR the full listing or the refetch reads gets its draft and merged_at, and the change reports pulls (#186)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(5, T2, { state: 'closed', closedAt: T2 }), 'sync');
  const listing = fakeRest([ok([restPr(5, T2, T2)]), ok([])]);
  assert.deepEqual((await reconcile({ db, rest: listing.rest, source: SOURCE, now: NOW }, REPO)).kinds, ['pulls']);
  assert.deepEqual(db.prs(SOURCE, REPO, 'merged').map((r) => r.number), [5]);
  const refetch = fakeRest([ok(restPr(7, T1, null, { draft: true })), ok([])]);
  assert.deepEqual(await refetchIssue({ db, rest: refetch.rest, gql: NO_GQL, source: SOURCE, now: NOW }, REPO, 7), { outcome: 'changed', kinds: ['pulls'] }); // PR 7 was not stored: db.issue never reads a PR, so the snapshot sees no issues change; only its flags are new
  assert.deepEqual(db.prs(SOURCE, REPO, 'open').map((r) => [r.number, r.isDraft]), [[7, true]]);
});

interface Page { body: unknown; etag: string }
const OTHER_HEAD = 'b'.repeat(40);
const RUN_OK = { name: 'test', status: 'completed', conclusion: 'success' };
const RUNS_OK: Page = { body: { total_count: 1, check_runs: [RUN_OK] }, etag: 'ER1' };
const CHECK_PARTS = ['runs', 'status', 'suites'] as const;
const ORIGINAL: RepoRef = { ...REF, role: 'original', pair: 'bia/hive' };
const restPull = (n: number, sha: string): Record<string, unknown> => ({ number: n, head: { sha, ref: 'feature' }, mergeable_state: 'clean' });
// What GitHub answers the poll of PR n at head sha
const pagesAt = (sha: string, runs: Page = RUNS_OK, n = 7): Record<string, Page> => ({
  [pullPath(REPO, n)]: { body: restPull(n, sha), etag: `EP-${sha.slice(0, 1)}` },
  [checkPath(REPO, sha, 'runs')]: runs,
  [checkPath(REPO, sha, 'status')]: { body: { state: 'pending', statuses: [] }, etag: 'ES' },
  [checkPath(REPO, sha, 'suites')]: { body: { total_count: 0, check_suites: [] }, etag: 'EU' },
});

// GitHub over `pages`: a 304 to a page's own ETag, as GitHub does; a path it lacks fails as the transport does. Every [path, etag] recorded
function github(pages: Record<string, Page>): { rest: RestGet; calls: [string, string | undefined][] } {
  const calls: [string, string | undefined][] = [];
  const rest: RestGet = async (path, etag) => {
    calls.push([path, etag]);
    const page = pages[path];
    if (page === undefined) throw new Error(`github rest: HTTP 404 for ${path}`);
    return etag === page.etag ? { status: 304 } : ok(page.body, { etag: page.etag });
  };
  return { rest, calls };
}

const gqlPull = (id: string): Record<string, unknown> => ({
  id, reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', headCommit: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
});

// The batch as GitHub answers it, each PR at its alias; the ids of every call recorded
function fakeBatch(): { gql: Gql; calls: string[][] } {
  const calls: string[][] = [];
  const gql: Gql = async (_query, variables = {}) => {
    const ids = Object.values(variables).map(String);
    calls.push(ids);
    return Object.fromEntries(ids.map((id, i) => [`p${i}`, gqlPull(id)]));
  };
  return { gql, calls };
}

const NO_REST: RestGet = async (path) => {
  throw new Error(`unexpected ${path}`);
};
const roundDeps = (db: ReadModel, rest: RestGet, gql: Gql = NO_GQL) => ({ db, rest, gql, source: SOURCE, now: NOW });

test('the poll of an open PR reads every part first; a quiet round answers 304 on each and emits nothing; a new check run reports pulls; a new head reads the checks without the old ETags (#186)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullRead(pullKey(7), { decision: null, readAt: T1 }); // read already: no batch
  assert.deepEqual((await syncPulls(roundDeps(db, github(pagesAt(HEAD)).rest), REF)).report, { kinds: ['pulls'], requests: { 200: 4, 304: 0 } });
  assert.equal(db.prs(SOURCE, REPO, 'open')[0]?.checks, 'success');
  const quiet = github(pagesAt(HEAD));
  assert.deepEqual(await syncPulls(roundDeps(db, quiet.rest), REF), { report: { kinds: [], requests: { 200: 0, 304: 4 } }, errors: [] });
  assert.deepEqual(quiet.calls.map(([, etag]) => etag), ['EP-a', 'ER1', 'ES', 'EU']);
  const failing: Page = { body: { total_count: 2, check_runs: [RUN_OK, { name: 'lint', status: 'completed', conclusion: 'failure' }] }, etag: 'ER2' };
  assert.deepEqual((await syncPulls(roundDeps(db, github(pagesAt(HEAD, failing)).rest), REF)).report, { kinds: ['pulls'], requests: { 200: 1, 304: 3 } });
  assert.equal(db.prs(SOURCE, REPO, 'open')[0]?.checks, 'failure');
  const moved = github(pagesAt(OTHER_HEAD));
  await syncPulls(roundDeps(db, moved.rest), REF);
  assert.deepEqual(moved.calls, [[pullPath(REPO, 7), 'EP-a'], ...CHECK_PARTS.map((part) => [checkPath(REPO, OTHER_HEAD, part), undefined])]);
  assert.equal(db.openPulls(SOURCE, REPO)[0]?.headSha, OTHER_HEAD);
});

test('the batch asks only the PRs whose updated_at moved past read_at, at most 100 ids per call, and gives a closed PR its decision, checks and merge state (#186)', async (t) => {
  const db = await tempModel(t);
  db.transaction(() => {
    for (let n = 1; n <= BATCH_SIZE + 1; n += 1) db.upsertIssue(prIssueRow(n, T1, { state: 'closed', closedAt: T1 }), 'sync');
  });
  const first = fakeBatch();
  const { report, errors } = await syncPulls(roundDeps(db, NO_REST, first.gql), REF);
  assert.deepEqual([first.calls.map((ids) => ids.length), report.kinds, errors], [[BATCH_SIZE, 1], ['pulls'], []]);
  const [row] = db.prs(SOURCE, REPO, 'closed');
  assert.deepEqual([row?.decision, row?.checks, row?.mergeState], ['approved', 'failure', 'blocked']);
  const next = fakeBatch();
  await syncPulls(roundDeps(db, NO_REST, next.gql), REF);
  assert.deepEqual(next.calls, [], 'every PR read at its updated_at');
  db.upsertIssue(prIssueRow(3, T2, { state: 'closed', closedAt: T1 }), 'sync');
  await syncPulls(roundDeps(db, NO_REST, next.gql), REF);
  assert.deepEqual(next.calls, [['PR_3']]);
});

test('a failed batch is the round\'s error and leaves read_at, so the next round asks again; the poll still runs (#186)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  const limited: Gql = async () => {
    throw new Error('gh api graphql: API rate limit exceeded');
  };
  const { errors } = await syncPulls(roundDeps(db, github(pagesAt(HEAD)).rest, limited), REF);
  assert.match(String(errors[0]), /rate limit/);
  assert.deepEqual(db.pullsToRead(SOURCE, REPO).map((pr) => pr.number), [7]);
  assert.equal(db.prs(SOURCE, REPO, 'open')[0]?.checks, 'success', 'the poll ran');
});

test('on an open PR the batch sets only the decision: the poll\'s checks and merge state stand (#186)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  await syncPulls(roundDeps(db, github(pagesAt(HEAD)).rest, fakeBatch().gql), REF);
  db.upsertIssue(prIssueRow(7, T2), 'sync'); // a review bumps updated_at: the batch reads it again while the poll answers 304
  const batch = fakeBatch();
  await syncPulls(roundDeps(db, github(pagesAt(HEAD)).rest, batch.gql), REF);
  const [row] = db.prs(SOURCE, REPO, 'open');
  assert.deepEqual([batch.calls, row?.decision, row?.checks, row?.mergeState], [[['PR_7']], 'approved', 'success', 'clean']);
});

test('a PR that stops being open drops its poll scopes; its row stays as last read (#186)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullRead(pullKey(7), { decision: null, readAt: T1 });
  await syncPulls(roundDeps(db, github(pagesAt(HEAD)).rest), REF);
  assert.equal(db.scope(SOURCE, REPO, 'pull/7/runs')?.cursor, 'success', 'the reading rides beside its ETag');
  db.upsertIssue(prIssueRow(7, T2, { state: 'closed', closedAt: T2 }), 'sync');
  await syncPulls(roundDeps(db, NO_REST, fakeBatch().gql), REF);
  const parts = (['pr', ...CHECK_PARTS] as const).map((part) => db.scope(SOURCE, REPO, `pull/7/${part}` as const));
  assert.deepEqual(parts, [undefined, undefined, undefined, undefined]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'closed').map((r) => [r.number, r.decision]), [[7, 'approved']]);
});

test('on an original the batch and the poll touch only the login\'s PRs (#186)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync'); // bia's, the login of SOURCE
  db.upsertIssue(prIssueRow(9, T1, { author: 'caio' }), 'sync');
  const gh = github(pagesAt(HEAD));
  const batch = fakeBatch();
  const { errors } = await syncPulls(roundDeps(db, gh.rest, batch.gql), ORIGINAL);
  assert.deepEqual([errors, batch.calls], [[], [['PR_7']]]);
  assert.ok(gh.calls.every(([path]) => !path.includes('/pulls/9')));
  assert.deepEqual(db.pullsToRead(SOURCE, REPO).map((pr) => pr.number), [9], 'caio\'s PR is never read');
});

test('a failing PR poll is collected: that PR keeps its scopes and row, the next PR still polls (#186)', async (t) => {
  const db = await tempModel(t);
  for (const n of [7, 8]) {
    db.upsertIssue(prIssueRow(n, T1), 'sync');
    db.setPullRead(pullKey(n), { decision: null, readAt: T1 });
  }
  const { errors } = await syncPulls(roundDeps(db, github(pagesAt(HEAD, RUNS_OK, 8)).rest), REF);
  assert.match(String(errors[0]), /pulls\/7/);
  assert.deepEqual(db.prs(SOURCE, REPO, 'open').map((r) => [r.number, r.checks]), [[8, 'success'], [7, undefined]]);
  assert.equal(db.scope(SOURCE, REPO, 'pull/7/pr'), undefined);
});

test('a round runs the PR part after the issue scopes and reports pulls (#186)', async (t) => {
  const db = await tempModel(t);
  const gh = github({
    [repoPath(REPO)]: { body: REST_REPO, etag: 'ERP' }, [labelsPath(REPO)]: { body: [], etag: 'EL' },
    [scopePath(REPO, 'issues', null)]: { body: [restPr(7, T1)], etag: 'EI' }, [scopePath(REPO, 'comments', null)]: { body: [], etag: 'EC' }, ...pagesAt(HEAD),
  });
  const batch = fakeBatch();
  const { report, error } = await syncRepository(roundDeps(db, gh.rest, batch.gql), REF);
  assert.equal(error, undefined);
  assert.deepEqual([report.kinds, batch.calls], [['issues', 'repo', 'pulls'], [['PR_7']]]);
  assert.deepEqual(gh.calls.slice(4).map(([path]) => path), [pullPath(REPO, 7), ...CHECK_PARTS.map((part) => checkPath(REPO, HEAD, part))]);
});
