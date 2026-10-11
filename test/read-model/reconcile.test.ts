import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel } from '../../src/read-model/db.js';
import { reconcile, refetchIssue } from '../../src/read-model/reconcile.js';
import { scopeOf } from '../../src/read-model/sync.js';
import { commentRow, fakeRest, issueRow, NOW, ok, REPO, restComment, restIssue, SOURCE, T1, T2 } from './fixtures.js';

test('the reconciliation removes the issues and comments missing from the full listing, and stamps its scope (#765)', async () => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(1, T1));
  db.upsertIssue(issueRow(2, T1));
  db.upsertComment(commentRow('C1', 'I_1'));
  db.upsertComment(commentRow('C3', 'I_1'));
  const { rest, calls } = fakeRest([ok([restIssue(1, T1)], { next: 'page-2' }), ok([]), ok([restComment('C1', 1, T1)])]);
  const report = await reconcile({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.deepEqual(calls.map(([path]) => path), ['repos/acme/hive/issues?state=all&per_page=100', 'page-2', 'repos/acme/hive/issues/comments?per_page=100']);
  assert.deepEqual([db.nodeIds(SOURCE, REPO, 'issues'), db.nodeIds(SOURCE, REPO, 'comments')], [['I_1'], ['C1']]);
  assert.deepEqual(report, { changed: true, requests: { 200: 3, 304: 0 } });
  assert.equal(db.cursor(scopeOf(SOURCE, REPO, 'reconcile'))?.syncedAt, NOW().toISOString());
});

test('the detail refetch stores the issue and all its comments, drops a comment GitHub no longer lists, and says whether anything changed (#765)', async () => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(12, T1));
  db.upsertComment(commentRow('C_gone', 'I_12'));
  const same = [ok(restIssue(12, T2)), ok([restComment('C1', 12, T2)])];
  const { rest, calls } = fakeRest([...same, ...same]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  assert.equal(await refetchIssue(deps, REPO, 12), true);
  assert.deepEqual(calls.slice(0, 2).map(([path]) => path), ['repos/acme/hive/issues/12', 'repos/acme/hive/issues/12/comments?per_page=100']);
  assert.equal(db.issue(SOURCE, REPO, 12)?.updatedAt, T2);
  assert.deepEqual(db.comments(SOURCE, 'I_12').map((c) => c.nodeId), ['C1']);
  assert.equal(await refetchIssue(deps, REPO, 12), false, 'the same answers change nothing');
});

test('the detail refetch removes an issue answered 404, or moved to another repository, with its comments (#765)', async () => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(12, T1));
  db.upsertComment(commentRow('C1', 'I_12'));
  db.upsertIssue(issueRow(13, T1));
  const { rest } = fakeRest([{ status: 404 }, ok({ ...restIssue(13, T2), repository_url: 'https://api.github.com/repos/acme/elsewhere' }), { status: 404 }]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  assert.equal(await refetchIssue(deps, REPO, 12), true);
  assert.equal(await refetchIssue(deps, REPO, 13), true);
  assert.deepEqual([db.nodeIds(SOURCE, REPO, 'issues'), db.nodeIds(SOURCE, REPO, 'comments')], [[], []]);
  assert.equal(await refetchIssue(deps, REPO, 12), false, 'nothing stored, nothing changed');
});
