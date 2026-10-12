import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readModelEvent, RECONCILE_EVERY_MS, syncRepository } from '../../src/read-model/loop.js';
import type { RestGet } from '../../src/read-model/rest.js';
import { scopePath } from '../../src/read-model/sync.js';
import { fakeRest, NOW, ok, REPO, restComment, restIssue, SOURCE, SYNCED, T1, T2, tempModel } from './fixtures.js';

const OTHER = 'acme/other';
const listing = (repository: string): string[] => [`repos/${repository}/issues?state=all&per_page=100`, `repos/${repository}/issues/comments?per_page=100`];
const stampAgo = (msAgo: number): string => new Date(NOW().getTime() - msAgo).toISOString();

test('the readModel event is a named frame with its repository and kinds (#180)', () => {
  assert.equal(readModelEvent(REPO, ['issues']), 'event: readModel\ndata: {"type":"readModel","repository":"acme/hive","kinds":["issues"]}\n\n');
});

test('a repository syncs issues then comments; a first round from null that ends complete stamps the reconcile scope instead of listing (#180)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([ok([restIssue(1, T1)]), ok([restComment('C1', 1, T1)])]);
  const { report, error } = await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.equal(error, undefined);
  assert.deepEqual(report, { kinds: ['issues', 'comments'], requests: { 200: 2, 304: 0 } });
  assert.deepEqual(calls.map(([path]) => path), [scopePath(REPO, 'issues', null), scopePath(REPO, 'comments', null)]);
  assert.equal(db.scope(SOURCE, REPO, 'reconcile')?.syncedAt, SYNCED);
});

test('a first round cut short does not count as the full listing: the listing runs in that round (#180)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([ok([restIssue(1, T1)]), ok([restComment('C9', 9, T1)]), ok([restIssue(1, T1)]), ok([])]);
  await syncRepository({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.deepEqual(calls.slice(2).map(([path]) => path), listing(REPO));
});

test('the full listing runs when the reconcile stamp is absent or older than 24 h, not at exactly 24 h (#180)', async (t) => {
  const db = await tempModel(t);
  for (const repository of [REPO, OTHER]) {
    for (const kind of ['issues', 'comments'] as const) db.setScope(SOURCE, repository, kind, { cursor: T1, etag: 'E', syncedAt: T1 });
  }
  const stamp = (msAgo: number): void => db.setScope(SOURCE, REPO, 'reconcile', { cursor: null, etag: null, syncedAt: stampAgo(msAgo) });
  stamp(RECONCILE_EVERY_MS);
  const quiet = fakeRest([{ status: 304 }, { status: 304 }]);
  await syncRepository({ db, rest: quiet.rest, source: SOURCE, now: NOW }, REPO);
  assert.equal(quiet.calls.length, 2, 'exactly 24 h is not older than 24 h');
  stamp(RECONCILE_EVERY_MS + 1000);
  const due = fakeRest([{ status: 304 }, { status: 304 }, ok([]), ok([])]);
  const { report } = await syncRepository({ db, rest: due.rest, source: SOURCE, now: NOW }, REPO);
  assert.deepEqual(due.calls.slice(2).map(([path]) => path), listing(REPO));
  assert.deepEqual(report.requests, { 200: 2, 304: 2 });
  assert.equal(db.scope(SOURCE, REPO, 'reconcile')?.syncedAt, SYNCED);
  const absent = fakeRest([{ status: 304 }, { status: 304 }, ok([]), ok([])]);
  await syncRepository({ db, rest: absent.rest, source: SOURCE, now: NOW }, OTHER);
  assert.deepEqual(absent.calls.slice(2).map(([path]) => path), listing(OTHER), 'no stamp at all is due');
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
