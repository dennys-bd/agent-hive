import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncStopped } from '../../src/read-model/sync.js';
import { reconcile, refetchIssue } from '../../src/read-model/reconcile.js';
import { httpRest } from '../../src/read-model/rest.js';
import type { Gql } from '../../src/types.js';
import {
  CLOSING_PRS, commentRow, fakeLinks, fakeRest, GQL_CLOSING_PRS, issueRow, NOW, ok, REPO, restComment, restIssue, SOURCE, SYNCED, T1, T2, tempModel,
} from './fixtures.js';

test('the full listing removes the issues and comments GitHub no longer lists, reports their kinds and stamps the reconcile scope (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(1, T1), 'sync');
  db.upsertIssue(issueRow(2, T1), 'sync');
  db.upsertComment(commentRow('C1', 'I_1'), 'sync');
  db.upsertComment(commentRow('C3', 'I_1'), 'sync');
  const { rest, calls } = fakeRest([ok([restIssue(1, T1)], { next: 'repositories/1/issues?page=2' }), ok([]), ok([restComment('C1', 1, T1)])]);
  const report = await reconcile({ db, rest, source: SOURCE, now: NOW }, REPO);
  assert.deepEqual(calls, [['repos/acme/hive/issues?state=all&per_page=100', undefined], ['repositories/1/issues?page=2', undefined], ['repos/acme/hive/issues/comments?per_page=100', undefined]]);
  assert.deepEqual([db.nodeIds(SOURCE, REPO, 'issues'), db.nodeIds(SOURCE, REPO, 'comments')], [['I_1'], ['C1']]);
  assert.deepEqual(report, { kinds: ['issues', 'comments'], requests: { 200: 3, 304: 0 } });
  assert.deepEqual(db.scope(SOURCE, REPO, 'reconcile'), { cursor: null, etag: null, syncedAt: SYNCED });
});

test('a listing that removes only an issue reports issues; one that removes nothing reports no kind (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(1, T1), 'sync');
  db.upsertIssue(issueRow(2, T1), 'sync');
  const listing = [ok([restIssue(1, T1)]), ok([])];
  const { rest } = fakeRest([...listing, ...listing]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  assert.deepEqual((await reconcile(deps, REPO)).kinds, ['issues']);
  assert.deepEqual((await reconcile(deps, REPO)).kinds, []);
});

test('a Link outside the repository aborts the full listing before its delete: nothing removed, nothing stamped (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(1, T1), 'sync');
  db.upsertIssue(issueRow(2, T1), 'sync');
  const page = new Response(JSON.stringify([restIssue(1, T1)]), { status: 200, headers: { Link: '<https://api.github.com/repos/acme/elsewhere/issues?page=2>; rel="next"' } });
  const rest = httpRest({ token: async () => 'test-token', fetch: (async () => page) as unknown as typeof fetch });
  await assert.rejects(reconcile({ db, rest, source: SOURCE, now: NOW }, REPO), { message: 'github rest: next page outside the repository' });
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'issues').sort(), ['I_1', 'I_2']);
  assert.equal(db.scope(SOURCE, REPO, 'reconcile'), undefined);
});

test('the refetch stores the issue and all its comments, drops a comment GitHub no longer lists, answers changed with its kinds, then unchanged (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(12, T1), 'sync');
  db.upsertComment(commentRow('C_gone', 'I_12'), 'sync');
  const same = [ok(restIssue(12, T2)), ok([restComment('C1', 12, T2)])];
  const { rest, calls } = fakeRest([...same, ...same]);
  const deps = { db, rest, gql: fakeLinks().gql, source: SOURCE, now: NOW };
  assert.deepEqual(await refetchIssue(deps, REPO, 12), { outcome: 'changed', kinds: ['issues', 'comments'] });
  assert.deepEqual(calls.slice(0, 2).map(([path]) => path), ['repos/acme/hive/issues/12', 'repos/acme/hive/issues/12/comments?per_page=100']);
  assert.equal(db.issue(SOURCE, REPO, 12)?.updatedAt, T2);
  assert.deepEqual(db.comments(SOURCE, 'I_12').map((c) => c.nodeId), ['C1']);
  assert.deepEqual(await refetchIssue(deps, REPO, 12), { outcome: 'unchanged', kinds: [] });
});

test('the refetch stores the issue\'s closing PRs, read with one GraphQL call; a change of them alone is a change of issues (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(12, T2), 'sync');
  const links = fakeLinks(GQL_CLOSING_PRS);
  const { rest } = fakeRest([ok(restIssue(12, T2)), ok([])]);
  assert.deepEqual(await refetchIssue({ db, rest, gql: links.gql, source: SOURCE, now: NOW }, REPO, 12), { outcome: 'changed', kinds: ['issues'] });
  assert.deepEqual(links.calls, [{ owner: 'acme', name: 'hive', number: 12 }]);
  assert.deepEqual(db.issue(SOURCE, REPO, 12)?.pullRequests, CLOSING_PRS);
});

test('a GraphQL failure keeps the REST part: the issue is stored, its links stay as they were, and the reason is reported (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(12, T1), 'sync');
  db.setClosingPrs(SOURCE, 'I_12', CLOSING_PRS);
  const gql: Gql = async () => {
    throw new Error('github api: HTTP 502');
  };
  const { rest } = fakeRest([ok(restIssue(12, T2)), ok([])]);
  assert.deepEqual(await refetchIssue({ db, rest, gql, source: SOURCE, now: NOW }, REPO, 12), { outcome: 'changed', kinds: ['issues'], linksError: 'github api: HTTP 502' });
  assert.equal(db.issue(SOURCE, REPO, 12)?.updatedAt, T2);
  assert.deepEqual(db.issue(SOURCE, REPO, 12)?.pullRequests, CLOSING_PRS);
});

test('the refetch removes an issue answered 404, or moved to another repository, with its comments: gone, and no GraphQL call (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(12, T1), 'sync');
  db.upsertComment(commentRow('C1', 'I_12'), 'sync');
  db.upsertIssue(issueRow(13, T1), 'sync');
  const { rest } = fakeRest([{ status: 404 }, ok({ ...restIssue(13, T2), repository_url: 'https://api.github.com/repos/acme/elsewhere' }), { status: 410 }]);
  const links = fakeLinks();
  const deps = { db, rest, gql: links.gql, source: SOURCE, now: NOW };
  assert.deepEqual(await refetchIssue(deps, REPO, 12), { outcome: 'gone', kinds: ['issues', 'comments'] });
  assert.deepEqual(await refetchIssue(deps, REPO, 13), { outcome: 'gone', kinds: ['issues'] });
  assert.deepEqual([db.nodeIds(SOURCE, REPO, 'issues'), db.nodeIds(SOURCE, REPO, 'comments')], [[], []]);
  assert.deepEqual(await refetchIssue(deps, REPO, 12), { outcome: 'gone', kinds: [] }, 'nothing stored, nothing changed');
  assert.equal(links.calls.length, 0);
});

test('a PR read through the issues endpoint asks GraphQL nothing: it has no closing PRs (#180)', async (t) => {
  const db = await tempModel(t);
  const links = fakeLinks();
  const { rest } = fakeRest([ok({ ...restIssue(14, T1), pull_request: { url: 'https://api.github.com/repos/acme/hive/pulls/14' } }), ok([])]);
  await refetchIssue({ db, rest, gql: links.gql, source: SOURCE, now: NOW }, REPO, 14);
  assert.equal(links.calls.length, 0);
  assert.equal(db.nodeIdOf(SOURCE, REPO, 14), 'I_14');
});

test('a stop between the listing\'s pages ends it before anything is removed or stamped (#180)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(1, T1), 'sync');
  let stopped = false;
  let requests = 0;
  const rest = async (): Promise<ReturnType<typeof ok>> => {
    requests += 1;
    stopped = true;
    return ok([], { next: 'repos/acme/hive/issues?page=2' });
  };
  await assert.rejects(reconcile({ db, rest, source: SOURCE, now: NOW, isStopped: () => stopped }, REPO), SyncStopped);
  assert.equal(requests, 1);
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'issues'), ['I_1']);
  assert.equal(db.scope(SOURCE, REPO, 'reconcile'), undefined);
});
