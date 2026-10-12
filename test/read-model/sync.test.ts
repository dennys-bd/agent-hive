import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { RestGet } from '../../src/read-model/rest.js';
import assert from 'node:assert/strict';
import { PartialSyncError, scopePath, syncScope } from '../../src/read-model/sync.js';
import { deferred, fakeRest, issueRow, NOW, ok, REPO, restComment, restIssue, SOURCE, SYNCED, T1, T2, T3, tempModel } from './fixtures.js';

test('the scope paths: state=all, sort=updated ascending, 100 a page, since only with a cursor (#180)', () => {
  assert.equal(scopePath(REPO, 'issues', null), 'repos/acme/hive/issues?state=all&sort=updated&direction=asc&per_page=100');
  assert.equal(scopePath(REPO, 'comments', T1), 'repos/acme/hive/issues/comments?sort=updated&direction=asc&per_page=100&since=2026-10-05T09%3A00%3A00Z');
});

test('the issues scope stores every page, moves the cursor to the last updated_at and drops an ETag the moved cursor no longer names (#180)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([ok([restIssue(1, T1), restIssue(2, T2)], { next: 'repos/acme/hive/issues?page=2', etag: 'E1' }), ok([restIssue(3, T3)])]);
  assert.deepEqual(await syncScope({ db, rest, source: SOURCE, now: NOW }, REPO, 'issues'), { kinds: ['issues'], requests: { 200: 2, 304: 0 }, full: true });
  assert.deepEqual(calls, [[scopePath(REPO, 'issues', null), undefined], ['repos/acme/hive/issues?page=2', undefined]]);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T3, etag: null, syncedAt: SYNCED });
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'issues').sort(), ['I_1', 'I_2', 'I_3']);
});

test('an unchanged scope keeps its ETag: the inclusive since answers the last row again and writes nothing, and the next run\'s 304 changes nothing (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(3, T3), 'sync');
  db.setScope(SOURCE, REPO, 'issues', { cursor: T3, etag: null, syncedAt: T1 });
  const { rest, calls } = fakeRest([ok([restIssue(3, T3)], { etag: 'E2' }), { status: 304 }]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  assert.deepEqual(await syncScope(deps, REPO, 'issues'), { kinds: [], requests: { 200: 1, 304: 0 }, full: false });
  assert.deepEqual(await syncScope(deps, REPO, 'issues'), { kinds: [], requests: { 200: 0, 304: 1 }, full: false });
  assert.deepEqual(calls, [[scopePath(REPO, 'issues', T3), undefined], [scopePath(REPO, 'issues', T3), 'E2']]);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T3, etag: 'E2', syncedAt: SYNCED }, 'a 304 is a complete round: syncedAt moves');
});

test('a comment whose issue is not stored stops the scope: neither the ETag nor a cursor past it is saved, and the next run stores it once its issue is (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(1, T1), 'sync');
  db.setScope(SOURCE, REPO, 'comments', { cursor: T1, etag: null, syncedAt: T1 });
  const page = [restComment('C9', 9, T2), restComment('C1', 1, T3)];
  const first = fakeRest([ok(page, { etag: 'E9', next: 'repos/acme/hive/issues/comments?page=2' })]);
  const deps = { db, rest: first.rest, source: SOURCE, now: NOW };
  assert.deepEqual(await syncScope(deps, REPO, 'comments'), { kinds: [], requests: { 200: 1, 304: 0 }, full: false, blocked: true });
  assert.equal(first.calls.length, 1, 'the next page is not read');
  assert.deepEqual(db.scope(SOURCE, REPO, 'comments'), { cursor: T1, etag: null, syncedAt: T1 }, 'cursor and syncedAt stand, no ETag');
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'comments'), []);
  db.upsertIssue(issueRow(9, T2), 'sync');
  const second = fakeRest([ok(page, { etag: 'E10' })]);
  assert.deepEqual(await syncScope({ ...deps, rest: second.rest }, REPO, 'comments'), { kinds: ['comments'], requests: { 200: 1, 304: 0 }, full: false });
  assert.deepEqual(second.calls, [[scopePath(REPO, 'comments', T1), undefined]], 'no ETag sent: none was saved');
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'comments').sort(), ['C1', 'C9']);
  assert.deepEqual(db.scope(SOURCE, REPO, 'comments'), { cursor: T3, etag: null, syncedAt: SYNCED });
});

test('a page cut short keeps what came before the blocked comment: the cursor stops on the last comment stored (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(1, T1), 'sync');
  const { rest, calls } = fakeRest([ok([restComment('C1', 1, T1), restComment('C2', 9, T2), restComment('C3', 1, T3)], { next: 'repos/acme/hive/issues/comments?page=2', etag: 'E1' })]);
  assert.deepEqual(await syncScope({ db, rest, source: SOURCE, now: NOW }, REPO, 'comments'), { kinds: ['comments'], requests: { 200: 1, 304: 0 }, full: false, blocked: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'comments'), ['C1']);
  assert.deepEqual(db.scope(SOURCE, REPO, 'comments'), { cursor: T1, etag: null, syncedAt: null });
});

test('a list answered with anything but 200 or 304 throws before its scope is written (#180)', async (t) => {
  const db = await tempModel(t);
  db.setScope(SOURCE, REPO, 'issues', { cursor: T1, etag: 'E', syncedAt: T1 });
  const { rest } = fakeRest([{ status: 404 }]);
  await assert.rejects(syncScope({ db, rest, source: SOURCE, now: NOW }, REPO, 'issues'), { message: 'read model: the issues of acme/hive answered HTTP 404' });
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T1, etag: 'E', syncedAt: T1 });
});

test('a scope that fails after storing a page reports what that page changed and keeps its cursor (#180)', async (t) => {
  const db = await tempModel(t);
  db.setScope(SOURCE, REPO, 'issues', { cursor: T1, etag: 'E', syncedAt: T1 });
  const { rest } = fakeRest([ok([restIssue(2, T2)], { next: 'repos/acme/hive/issues?page=2' }), { status: 404 }]);
  const error = await syncScope({ db, rest, source: SOURCE, now: NOW }, REPO, 'issues').then(() => undefined, (err: unknown) => err);
  assert.ok(error instanceof PartialSyncError);
  assert.deepEqual(error.report.kinds, ['issues']);
  assert.match(error.message, /HTTP 404/);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T1, etag: 'E', syncedAt: T1 });
});

test('a stop between pages ends the scope without the pages left and without writing its place (#180)', async (t) => {
  const db = await tempModel(t);
  db.setScope(SOURCE, REPO, 'issues', { cursor: T1, etag: 'E', syncedAt: T1 });
  let stopped = false;
  const gate = deferred();
  const paths: string[] = [];
  const rest: RestGet = async (path) => {
    paths.push(path);
    if (paths.length === 2) await gate.promise;
    return ok([restIssue(paths.length, T2)], { next: `repos/acme/hive/issues?page=${paths.length + 1}` });
  };
  const running = syncScope({ db, rest, source: SOURCE, now: NOW, isStopped: () => stopped }, REPO, 'issues').catch((err: unknown) => err);
  await setImmediate();
  stopped = true;
  gate.resolve();
  assert.ok((await running) instanceof PartialSyncError);
  assert.equal(paths.length, 2, 'the third page is never requested');
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T1, etag: 'E', syncedAt: T1 });
});
