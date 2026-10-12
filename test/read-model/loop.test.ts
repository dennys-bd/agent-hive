import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { POLL_INTERVAL_MS, QUOTA_RESERVE } from '../../src/polling.js';
import { openReadModel, READ_MODEL_FILE, type ReadModel, type SyncKind } from '../../src/read-model/db.js';
import {
  createReadModelLoop, readModelEvent, RECONCILE_EVERY_MS, REFETCH_COOLDOWN_MS, syncRepository, type ReadModelLoop, type ReadModelLoopDeps,
} from '../../src/read-model/loop.js';
import { labelsPath, repoPath } from '../../src/read-model/repo-scopes.js';
import type { RestGet } from '../../src/read-model/rest.js';
import { scopePath } from '../../src/read-model/sync.js';
import type { Gql } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';
import { deferred, fakeLinks, fakeRest, issueRow, NOW, ok, REPO, REPO_SCOPES, REST_REPO, restComment, restIssue, restLabel, SOURCE, SYNCED, T1, T2, tempModel } from './fixtures.js';

const OTHER = 'acme/other';
const listing = (repository: string): string[] => [`repos/${repository}/issues?state=all&per_page=100`, `repos/${repository}/issues/comments?per_page=100`];
const stampAgo = (msAgo: number): string => new Date(NOW().getTime() - msAgo).toISOString();

test('the readModel event is a named frame with its repository and kinds (#180)', () => {
  assert.equal(readModelEvent(REPO, ['issues']), 'event: readModel\ndata: {"type":"readModel","repository":"acme/hive","kinds":["issues"]}\n\n');
});

test('a repository syncs issues then comments; a first round from null that ends complete stamps the reconcile scope instead of listing (#180)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([...REPO_SCOPES, ok([restIssue(1, T1)]), ok([restComment('C1', 1, T1)])]);
  const { report, error } = await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.equal(error, undefined);
  assert.deepEqual(report, { kinds: ['issues', 'comments', 'repo'], requests: { 200: 4, 304: 0 } });
  assert.deepEqual(calls.map(([path]) => path), [repoPath(REPO), labelsPath(REPO), scopePath(REPO, 'issues', null), scopePath(REPO, 'comments', null)]);
  assert.equal(db.scope(SOURCE, REPO, 'reconcile')?.syncedAt, SYNCED);
});

test('a first round cut short does not count as the full listing: the listing runs in that round (#180)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([...REPO_SCOPES, ok([restIssue(1, T1)]), ok([restComment('C9', 9, T1)]), ok([restIssue(1, T1)]), ok([])]);
  await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.deepEqual(calls.slice(4).map(([path]) => path), listing(REPO));
});

test('the full listing runs when the reconcile stamp is absent or older than 24 h, not at exactly 24 h (#180)', async (t) => {
  const db = await tempModel(t);
  for (const repository of [REPO, OTHER]) {
    for (const kind of ['issues', 'comments'] as const) db.setScope(SOURCE, repository, kind, { cursor: T1, etag: 'E', syncedAt: T1 });
  }
  const stamp = (msAgo: number): void => db.setScope(SOURCE, REPO, 'reconcile', { cursor: null, etag: null, syncedAt: stampAgo(msAgo) });
  stamp(RECONCILE_EVERY_MS);
  const quiet = fakeRest(Array(4).fill({ status: 304 }));
  await syncRepository({ db, rest: quiet.rest, source: SOURCE, now: NOW }, REPO);
  assert.equal(quiet.calls.length, 4, 'exactly 24 h is not older than 24 h');
  stamp(RECONCILE_EVERY_MS + 1000);
  const due = fakeRest([...Array(4).fill({ status: 304 }), ok([]), ok([])]);
  const { report } = await syncRepository({ db, rest: due.rest, source: SOURCE, now: NOW }, REPO);
  assert.deepEqual(due.calls.slice(4).map(([path]) => path), listing(REPO));
  assert.deepEqual(report.requests, { 200: 2, 304: 4 });
  assert.equal(db.scope(SOURCE, REPO, 'reconcile')?.syncedAt, SYNCED);
  const absent = fakeRest([...Array(4).fill({ status: 304 }), ok([]), ok([])]);
  await syncRepository({ db, rest: absent.rest, source: SOURCE, now: NOW }, OTHER);
  assert.deepEqual(absent.calls.slice(4).map(([path]) => path), listing(OTHER), 'no stamp at all is due');
});

test('a scope that throws ends the repository\'s round: what the issues scope stored is reported, the comments scope keeps its place (#180)', async (t) => {
  const db = await tempModel(t);
  db.setScope(SOURCE, REPO, 'comments', { cursor: T1, etag: 'EC', syncedAt: T1 });
  const rest: RestGet = async (path) => {
    if (path.includes('/comments')) throw new Error('gh api: HTTP 502');
    return ok([restIssue(1, T2)]);
  };
  const { report, error } = await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.deepEqual(report.kinds, ['issues']);
  assert.match(String(error), /HTTP 502/);
  assert.deepEqual(db.scope(SOURCE, REPO, 'comments'), { cursor: T1, etag: 'EC', syncedAt: T1 });
  assert.equal(db.scope(SOURCE, REPO, 'reconcile'), undefined, 'no listing and no stamp after a failure');
});

const quiet = { error: (): void => undefined, warn: (): void => undefined, debug: (): void => undefined };

interface LoopUnderTest { loop: ReadModelLoop; notified: [string, SyncKind[]][]; gqlCalls(): number }

function loopOn(db: ReadModel, rest: RestGet, extra: Partial<ReadModelLoopDeps> = {}): LoopUnderTest {
  const notified: [string, SyncKind[]][] = [];
  const links = fakeLinks();
  const loop = createReadModelLoop({
    db, access: async () => ({ source: SOURCE, rest, gql: links.gql }), repositories: async () => [REPO], log: quiet, now: NOW,
    notify: (repository, kinds) => {
      notified.push([repository, kinds]);
    },
    ...extra,
  });
  return { loop, notified, gqlCalls: () => links.calls.length };
}

test('a first round from null upserts, emits readModel once with its repository and kinds, lists nothing in full and calls no GraphQL (#180)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([...REPO_SCOPES, ok([restIssue(1, T1)], { etag: 'EI' }), ok([restComment('C1', 1, T1)], { etag: 'EC' })]);
  const { loop, notified, gqlCalls } = loopOn(db, rest);
  await loop.runOnce();
  assert.deepEqual(calls.map(([path]) => path), [repoPath(REPO), labelsPath(REPO), scopePath(REPO, 'issues', null), scopePath(REPO, 'comments', null)]);
  assert.deepEqual(notified, [[REPO, ['issues', 'comments', 'repo']]]);
  assert.equal(db.scope(SOURCE, REPO, 'reconcile')?.syncedAt, SYNCED);
  assert.equal(gqlCalls(), 0, 'a round never calls GraphQL');
});

test('an unchanged repository costs one 304 per scope and emits nothing (#180)', async (t) => {
  const db = await tempModel(t);
  for (const kind of ['issues', 'comments', 'repo', 'labels'] as const) db.setScope(SOURCE, REPO, kind, { cursor: T1, etag: `E-${kind}`, syncedAt: T1 });
  db.setScope(SOURCE, REPO, 'reconcile', { cursor: null, etag: null, syncedAt: SYNCED });
  const { rest, calls } = fakeRest(Array(4).fill({ status: 304 }));
  const { loop, notified } = loopOn(db, rest);
  await loop.runOnce();
  assert.deepEqual(calls.map(([, etag]) => etag), ['E-repo', 'E-labels', 'E-issues', 'E-comments']);
  assert.deepEqual(notified, []);
});

test('a round whose comments scope fails emits issues, keeps the comments cursor, logs it, and the next repository still syncs (#180)', async (t) => {
  const db = await tempModel(t);
  db.setScope(SOURCE, REPO, 'comments', { cursor: T1, etag: 'EC', syncedAt: T1 });
  const errors: string[] = [];
  const paths: string[] = [];
  const rest: RestGet = async (path) => {
    paths.push(path);
    if (path === 'repos/acme/other' || path === 'repos/acme/hive') return ok(REST_REPO);
    if (path.endsWith('/labels?per_page=100')) return ok([]);
    if (path.startsWith('repos/acme/hive/issues/comments')) throw new Error('gh api: HTTP 502');
    return path.startsWith('repos/acme/hive/issues') ? ok([restIssue(1, T2)]) : ok([]);
  };
  const log = { ...quiet, error: (message: string): void => { errors.push(message); } };
  const { loop, notified } = loopOn(db, rest, { repositories: async () => [REPO, 'acme/other'], log });
  await loop.runOnce();
  assert.deepEqual(notified, [[REPO, ['issues', 'repo']], ['acme/other', ['repo']]]); // the next repository stored its repos row
  assert.deepEqual(db.scope(SOURCE, REPO, 'comments'), { cursor: T1, etag: 'EC', syncedAt: T1 });
  assert.deepEqual(errors, ['read model: the sync of acme/hive failed: gh api: HTTP 502']);
  assert.ok(paths.some((p) => p.startsWith('repos/acme/other/issues?')), 'the next repository ran');
});

test('without a login for auth.github nothing syncs, it is logged once, and a refetch is skipped (#180)', async (t) => {
  const db = await tempModel(t);
  const errors: string[] = [];
  let requests = 0;
  const log = { ...quiet, error: (message: string): void => { errors.push(message); } };
  const { loop } = loopOn(db, async () => { requests += 1; return ok([]); }, { access: async () => undefined, log });
  await loop.runOnce();
  await loop.runOnce();
  assert.equal(await loop.refetch(REPO, 12), 'skipped');
  assert.equal(requests, 0);
  assert.deepEqual(errors, ['read model: no GitHub login for auth.github: nothing syncs until there is one']);
});

test('with no repository listed no access is read and no request made; a tick while a round runs is a no-op (#180)', async (t) => {
  const db = await tempModel(t);
  let reads = 0;
  const idle = loopOn(db, async () => ok([]), { repositories: async () => [], access: async () => { reads += 1; return undefined; } });
  await idle.loop.runOnce();
  assert.equal(reads, 0);
  const gate = deferred();
  const paths: string[] = [];
  const { loop } = loopOn(db, async (path) => {
    paths.push(path);
    await gate.promise;
    return ok([]);
  });
  const running = loop.runOnce();
  await loop.runOnce();
  await setImmediate();
  assert.equal(paths.length, 1, 'the second tick started nothing');
  gate.resolve();
  await running;
});

test('start() runs a round now and one every POLL_INTERVAL_MS; stop() clears the timer (#180)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const db = await tempModel(t);
  let listed = 0;
  const { loop } = loopOn(db, async () => ok([]), { repositories: async () => { listed += 1; return []; } });
  loop.start();
  await setImmediate();
  t.mock.timers.tick(POLL_INTERVAL_MS - 1);
  await setImmediate();
  assert.equal(listed, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(listed, 2);
  await loop.stop();
  t.mock.timers.tick(POLL_INTERVAL_MS);
  await setImmediate();
  assert.equal(listed, 2, 'no tick after stop');
});

test('below the REST reserve and before its reset, runOnce and refetch make no request; after the reset they do (#180)', async (t) => {
  const db = await tempModel(t);
  let clock = NOW().getTime();
  const low = { limit: 5000, remaining: QUOTA_RESERVE - 1, used: 4501, resetsAt: new Date(clock + 60_000).toISOString() };
  const paths: string[] = [];
  const rest: RestGet = async (path) => {
    paths.push(path);
    return path.endsWith('/issues/12') ? { status: 404, quota: low } : ok([], { quota: low });
  };
  const { loop } = loopOn(db, rest, { now: () => new Date(clock) });
  await loop.runOnce(); // learns the reading
  const learned = paths.length;
  await loop.runOnce();
  assert.equal(await loop.refetch(REPO, 12), 'skipped');
  assert.equal(paths.length, learned, 'no request inside the backoff');
  clock += 60_001;
  await loop.runOnce();
  assert.ok(paths.length > learned, 'the round resumes after resetsAt');
  assert.equal(await loop.refetch(REPO, 12), 'gone');
});

test('two concurrent refetches of one issue share one run and its outcome; a third within 10 s is skipped; after 10 s it runs again (#180)', async (t) => {
  const db = await tempModel(t);
  let clock = NOW().getTime();
  const gate = deferred();
  const paths: string[] = [];
  const rest: RestGet = async (path) => {
    paths.push(path);
    await gate.promise;
    return path.endsWith('/comments?per_page=100') ? ok([]) : ok(restIssue(12, T2));
  };
  const { loop, notified, gqlCalls } = loopOn(db, rest, { now: () => new Date(clock) });
  const first = loop.refetch(REPO, 12);
  const second = loop.refetch(REPO, 12);
  assert.equal(second, first, 'the same promise');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['changed', 'changed']);
  assert.deepEqual(paths, ['repos/acme/hive/issues/12', 'repos/acme/hive/issues/12/comments?per_page=100'], 'one gh run');
  assert.equal(gqlCalls(), 1, 'one closing-PR read');
  assert.deepEqual(notified, [[REPO, ['issues']]]);
  clock += REFETCH_COOLDOWN_MS - 1;
  assert.equal(await loop.refetch(REPO, 12), 'skipped');
  assert.equal(paths.length, 2);
  clock += 1;
  assert.equal(await loop.refetch(REPO, 12), 'unchanged');
  assert.equal(paths.length, 4);
  assert.equal(notified.length, 1, 'unchanged emits nothing');
});

test('a refetch whose REST run fails answers failed and logs it; one that finds the issue gone emits its kinds (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(12, T1), 'sync');
  const errors: string[] = [];
  const rest: RestGet = async (path) => {
    if (path.endsWith('/issues/7')) throw new Error('gh api: HTTP 502');
    return { status: 404 };
  };
  const log = { ...quiet, error: (message: string): void => { errors.push(message); } };
  const { loop, notified } = loopOn(db, rest, { log });
  assert.equal(await loop.refetch(REPO, 7), 'failed');
  assert.deepEqual(errors, ['read model: the refetch of acme/hive#7 failed: gh api: HTTP 502']);
  assert.equal(await loop.refetch(REPO, 12), 'gone');
  assert.deepEqual(notified, [[REPO, ['issues']]]);
});

test('a refetch whose closing PRs fail keeps the REST outcome and warns once (#180)', async (t) => {
  const db = await tempModel(t);
  const warnings: string[] = [];
  const gql: Gql = async () => {
    throw new Error('github api: HTTP 502');
  };
  const { rest } = fakeRest([ok(restIssue(12, T2)), ok([])]);
  const log = { ...quiet, warn: (message: string): void => { warnings.push(message); } };
  const { loop, notified } = loopOn(db, rest, { access: async () => ({ source: SOURCE, rest, gql }), log });
  assert.equal(await loop.refetch(REPO, 12), 'changed');
  assert.deepEqual(warnings, ['read model: the closing PRs of acme/hive#12 were not read: github api: HTTP 502']);
  assert.deepEqual(notified, [[REPO, ['issues']]]);
});

test('stop() resolves only after the running round and every refetch in flight settle; then the database closes, and nothing runs after (#180)', async (t) => {
  const { db } = await openReadModel(join(await tempDir(t, 'read-model-'), READ_MODEL_FILE));
  const gate = deferred();
  const called = deferred();
  const order: string[] = [];
  const paths: string[] = [];
  const rest: RestGet = async (path) => {
    paths.push(path);
    called.resolve();
    await gate.promise;
    if (path === repoPath(REPO)) return ok(REST_REPO);
    return path.endsWith('/issues/12') ? ok(restIssue(12, T1)) : ok([]);
  };
  const { loop } = loopOn(db, rest);
  const round = loop.runOnce().then(() => { order.push('round'); });
  const refetch = loop.refetch(REPO, 12).then(() => { order.push('refetch'); });
  await called.promise;
  const stopped = loop.stop().then(() => { order.push('stop'); });
  await setImmediate();
  assert.deepEqual(order, [], 'stop waits for the round and the refetch');
  gate.resolve();
  await Promise.all([round, refetch, stopped]);
  assert.deepEqual([order.length, order[2]], [3, 'stop']);
  assert.notEqual(db.scope(SOURCE, REPO, 'repo'), undefined, 'the round finished its writes (the repo scope is the first it runs)');
  db.close();
  const after = paths.length;
  await loop.runOnce();
  assert.equal(await loop.refetch(REPO, 13), 'skipped');
  assert.equal(paths.length, after, 'nothing runs once stopped');
});

test('a round whose second page fails still emits the kinds the first page stored, and the cursor stays (#180)', async (t) => {
  const db = await tempModel(t);
  db.setScope(SOURCE, REPO, 'issues', { cursor: T1, etag: 'EI', syncedAt: T1 });
  let pages = 0;
  const rest: RestGet = async (path) => {
    if (path === repoPath(REPO)) return ok(REST_REPO);
    if (path === labelsPath(REPO)) return ok([]);
    pages += 1;
    if (pages === 2) throw new Error('github rest: HTTP 500'); // what the transport throws for a 500
    return ok([restIssue(1, T2)], { next: 'repos/acme/hive/issues?page=2' });
  };
  const { loop, notified } = loopOn(db, rest);
  await loop.runOnce();
  assert.deepEqual(notified, [[REPO, ['issues', 'repo']]]);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T1, etag: 'EI', syncedAt: T1 });
});

test('stop() ends a scope between pages: the pages left are not requested, the place stands and nothing is logged as a failure (#180)', async (t) => {
  const db = await tempModel(t);
  db.setScope(SOURCE, REPO, 'issues', { cursor: T1, etag: 'EI', syncedAt: T1 });
  const gate = deferred();
  const errors: string[] = [];
  let pages = 0;
  const rest: RestGet = async (path) => {
    if (path === repoPath(REPO)) return ok(REST_REPO);
    if (path === labelsPath(REPO)) return ok([]);
    pages += 1;
    if (pages === 2) await gate.promise;
    return ok([restIssue(pages, T2)], { next: `repos/acme/hive/issues?page=${pages + 1}` });
  };
  const log = { ...quiet, error: (message: string): void => { errors.push(message); } };
  const { loop } = loopOn(db, rest, { log });
  const round = loop.runOnce();
  await setImmediate();
  const stopped = loop.stop();
  gate.resolve();
  await Promise.all([round, stopped]);
  assert.equal(pages, 2);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T1, etag: 'EI', syncedAt: T1 });
  assert.deepEqual(errors, []);
});

test('a comments scope that ends blocked logs one debug line naming the repository (#180)', async (t) => {
  const db = await tempModel(t);
  const debugs: string[] = [];
  const { rest } = fakeRest([...REPO_SCOPES, ok([restIssue(1, T1)]), ok([restComment('C9', 9, T1)]), ok([restIssue(1, T1)]), ok([])]);
  const log = { ...quiet, debug: (message: string): void => { debugs.push(message); } };
  const { loop } = loopOn(db, rest, { log });
  await loop.runOnce();
  assert.equal(debugs.filter((line) => line.includes('comments of acme/hive wait')).length, 1);
});

test('an issues scope that answers 410 (a fork with issues disabled) still stores the repos row with issuesEnabled false and the labels (#181)', async (t) => {
  const db = await tempModel(t);
  const rest: RestGet = async (path) => {
    if (path === repoPath(REPO)) return ok({ ...REST_REPO, has_issues: false });
    if (path === labelsPath(REPO)) return ok([restLabel('bug')]);
    return { status: 410 };
  };
  const { report, error } = await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.match(String(error), /410/);
  assert.deepEqual(report.kinds, ['repo', 'labels']);
  assert.equal(db.repo(SOURCE, REPO)?.issuesEnabled, false);
  assert.deepEqual(db.labels(SOURCE, REPO), ['bug']);
});

test('a repo scope that fails does not stop labels, issues, comments or the first-round stamp; the round reports its error (#181)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([{ status: 200, body: 'not a repository' }, ok([restLabel('bug')]), ok([restIssue(1, T1)]), ok([restComment('C1', 1, T1)])]);
  const { report, error } = await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.match(String(error), /repository/);
  assert.equal(calls.length, 4);
  assert.deepEqual(report.kinds, ['issues', 'comments', 'labels']);
  assert.equal(db.scope(SOURCE, REPO, 'reconcile')?.syncedAt, SYNCED);
  assert.equal(db.scope(SOURCE, REPO, 'repo'), undefined);
});

test('a failing labels scope does not stop the repos row; a round stopped before it starts makes no request and reports no error (#181)', async (t) => {
  const db = await tempModel(t);
  const rest: RestGet = async (path) => {
    if (path === labelsPath(REPO)) throw new Error('gh api: HTTP 502');
    return path === repoPath(REPO) ? ok(REST_REPO) : ok([]);
  };
  const { report, error } = await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.match(String(error), /HTTP 502/);
  assert.ok(report.kinds.includes('repo'));
  const calls: string[] = [];
  const stopped = await syncRepository({ db, rest: async (path) => { calls.push(path); return ok([]); }, source: SOURCE, now: NOW, isStopped: () => true }, REPO);
  assert.deepEqual([calls, stopped.error], [[], undefined]);
});
