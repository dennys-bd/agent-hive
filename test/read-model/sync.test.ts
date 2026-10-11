import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel } from '../../src/read-model/db.js';
import { scopeOf, scopePath, syncScope } from '../../src/read-model/sync.js';
import { fakeRest, issueRow, NOW, ok, REPO, restComment, restIssue, SOURCE, T1, T2, T3 } from './fixtures.js';

test('the scope paths are the spec\'s: state=all, sort=updated ascending, 100 a page, since only with a cursor (#765)', () => {
  assert.equal(scopePath(REPO, 'issues', null), 'repos/acme/hive/issues?state=all&sort=updated&direction=asc&per_page=100');
  assert.equal(scopePath(REPO, 'comments', T1), 'repos/acme/hive/issues/comments?sort=updated&direction=asc&per_page=100&since=2026-10-05T09%3A00%3A00Z');
  assert.equal(scopeOf(SOURCE, REPO, 'issues'), 'github:github.com:bia|acme/hive|issues');
});

test('the issues scope stores every page, advances the cursor to the last stored updated_at and drops an ETag the moved cursor no longer matches (#765)', async () => {
  const db = openReadModel(':memory:');
  const { rest, calls } = fakeRest([ok([restIssue(1, T1), restIssue(2, T2)], { next: 'page-2', etag: 'E1' }), ok([restIssue(3, T3)])]);
  assert.deepEqual(await syncScope({ db, rest, source: SOURCE, now: NOW }, REPO, 'issues'), { changed: true, requests: { 200: 2, 304: 0 } });
  assert.deepEqual(calls, [[scopePath(REPO, 'issues', null), undefined], ['page-2', undefined]]);
  assert.deepEqual(db.cursor(scopeOf(SOURCE, REPO, 'issues')), { cursor: T3, etag: null, syncedAt: NOW().toISOString() });
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'issues').sort(), ['I_1', 'I_2', 'I_3']);
});

test('the inclusive since answers the last issue again: no change and its ETag kept; the next run sends it and a 304 changes nothing (#765)', async () => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(3, T3));
  db.setCursor(scopeOf(SOURCE, REPO, 'issues'), { cursor: T3, etag: null, syncedAt: NOW().toISOString() });
  const { rest, calls } = fakeRest([ok([restIssue(3, T3)], { etag: 'E2' }), { status: 304 }]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  assert.deepEqual(await syncScope(deps, REPO, 'issues'), { changed: false, requests: { 200: 1, 304: 0 } });
  const stored = db.issue(SOURCE, REPO, 3);
  assert.deepEqual(await syncScope(deps, REPO, 'issues'), { changed: false, requests: { 200: 0, 304: 1 } });
  assert.deepEqual(calls, [[scopePath(REPO, 'issues', T3), undefined], [scopePath(REPO, 'issues', T3), 'E2']]);
  assert.deepEqual(db.issue(SOURCE, REPO, 3), stored);
  assert.deepEqual(db.cursor(scopeOf(SOURCE, REPO, 'issues')), { cursor: T3, etag: 'E2', syncedAt: NOW().toISOString() });
});

test('a comment whose issue is not stored stops its page: the cursor stays on the last comment stored and the next page is not read (#765)', async () => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(1, T1));
  const { rest, calls } = fakeRest([ok([restComment('C1', 1, T1), restComment('C2', 9, T2), restComment('C3', 1, T3)], { next: 'page-2' })]);
  assert.deepEqual(await syncScope({ db, rest, source: SOURCE, now: NOW }, REPO, 'comments'), { changed: true, requests: { 200: 1, 304: 0 } });
  assert.equal(calls.length, 1);
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'comments'), ['C1']);
  assert.equal(db.cursor(scopeOf(SOURCE, REPO, 'comments'))?.cursor, T1);
});

test('a comments page blocked on its first comment keeps no ETag, so the next round reads it again instead of a 304 (#765)', async () => {
  const db = openReadModel(':memory:');
  const { rest, calls } = fakeRest([ok([restComment('C9', 9, T1)], { etag: 'E1' }), ok([restComment('C9', 9, T1)])]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  await syncScope(deps, REPO, 'comments');
  assert.deepEqual(db.cursor(scopeOf(SOURCE, REPO, 'comments')), { cursor: null, etag: null, syncedAt: NOW().toISOString() });
  await syncScope(deps, REPO, 'comments');
  assert.equal(calls[1]?.[1], undefined);
});

test('a row stored at exactly the cursor is a change, though the cursor does not move (#765)', async () => {
  const db = openReadModel(':memory:');
  db.setCursor(scopeOf(SOURCE, REPO, 'issues'), { cursor: T1, etag: null, syncedAt: NOW().toISOString() });
  const { rest } = fakeRest([ok([restIssue(1, T1)])]);
  assert.equal((await syncScope({ db, rest, source: SOURCE, now: NOW }, REPO, 'issues')).changed, true);
});
