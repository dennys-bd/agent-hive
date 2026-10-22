import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { taskOfPr } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { prReviewPath } from '../src/pr-review-store.js';
import type { PrData, Task } from '../src/types.js';
import { withKeptRecord, withWork } from './fixtures/work.js';
import { ANCHOR, AT, fakeGh, HEAD, namedEventDuring, OTHER_PR, PR, PR2, prKey, reviewFileOf, startPrs, until } from './pr-server.js';
import { send } from './review-server.js';
import { hiveFetch } from './secret-client.js';

const H1 = 'b'.repeat(64);
// task 1 holds #7 (PR), task 2 #9 (PR2), no task #8 (OTHER_PR)
const route = (n = 7, repository = 'acme/app'): string => `/repositories/${repository}/pulls/${n}`;
const prOf = (base: string, n = 7, repository = 'acme/app'): Promise<Response> => hiveFetch(`${base}${route(n, repository)}`);
const queryOf = (call: { args: string[] }): string => call.args.find((arg) => arg.startsWith('query=')) ?? '';
// The source poll's PR states (#207) also reach gh on their own clock: the page's own calls are the ones that are not it
const PAGE_CALLS = (gh: { calls: { args: string[] }[] }, from = 0): { args: string[] }[] => gh.calls.slice(from).filter((c) => !queryOf(c).includes('p0: resource'));
const PAGE = { body: 'The description', author: 'bia', createdAt: AT, updatedAt: AT, headRef: 'feature', baseRef: 'main', commits: 1, additions: 1, deletions: 1, approvals: 0, canEdit: true, canPush: true, headOwner: 'acme', baseOwner: 'acme', reviews: [], comments: [], reviewRequests: [], closes: [] };

test('GET /repositories/:owner/:name/pulls/:number answers the PR\'s fields from the model with no diff, threads, compare or timeline call; an unlisted repository is 404, a malformed number 400 (#592, #758, #497)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const before = gh.calls.length;
  const res = await prOf(base);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    url: PR, id: 'PR_7', number: 7, title: 'The PR', state: 'open', isDraft: false, mergeState: 'clean', head: HEAD, methods: ['merge', 'squash'], viewer: 'ana', ...PAGE,
  });
  assert.deepEqual(PAGE_CALLS(gh, before), [], 'no gh call: the page is the model\'s');
  const unlisted = await prOf(base, 7, 'acme/other');
  assert.deepEqual([unlisted.status, await unlisted.json()], [404, { error: 'repository is not one the Hive lists' }]);
  for (const n of ['07', '1e2', 'x']) assert.equal((await hiveFetch(`${base}/repositories/acme/app/pulls/${n}`)).status, 400, n);
});

test('GET …/pulls/:number of a stored PR answers without awaiting its refetch (#497)', async (t) => {
  const gh = fakeGh();
  let refetched = false;
  gh.rest = async (path) => {
    if (path === 'repos/acme/app/issues/7') { await sleep(200); refetched = true; } // refetchIssue's own read
    return { status: 304 };
  };
  const { base } = await startPrs(t, gh);
  assert.equal((await prOf(base)).status, 200);
  assert.equal(refetched, false, 'answered while the refetch was still reading');
  await until(async () => refetched);
});

test('GET …/pulls/:number of a PR the model lacks waits for the refetch: none on GitHub is 404, GitHub unreachable 503 (#497)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const missing = await prOf(base, 10);
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'PR não encontrado' }]);
  gh.rest = async () => { throw new Error('gh api: HTTP 502'); };
  const unreachable = await prOf(base, 11);
  assert.deepEqual([unreachable.status, await unreachable.json()], [503, { error: 'could not reach GitHub' }]);
});

test('the PR review file: marks and drafts, each write broadcasting prReview; texts cleaned; refusals as the diff pane\'s; the general comment is gone (#592, #758)', async (t) => {
  const { base, home } = await startPrs(t, fakeGh());
  const path = route();
  const event = await namedEventDuring(base, 'prReview', () => send(base, 'POST', `${path}/reviewed`, { path: 'a.txt', hash: H1, reviewed: true }));
  assert.deepEqual(event, { type: 'prReview', url: PR });
  const { id } = await (await send(base, 'POST', `${path}/drafts`, { anchor: ANCHOR, text: '  look\u0007 ' })).json() as { id: string };
  assert.deepEqual((await reviewFileOf(base)).drafts, [{ id, anchor: ANCHOR, text: 'look' }], 'control characters out, trimmed');
  assert.equal((await send(base, 'PUT', `${path}/drafts/${id}`, { text: 'again' })).status, 200);
  const file = await reviewFileOf(base);
  assert.deepEqual(file, { reviewed: [{ path: 'a.txt', hash: H1 }], drafts: [{ id, anchor: ANCHOR, text: 'again' }] });
  assert.deepEqual(JSON.parse(await readFile(prReviewPath(home, PR), 'utf8')), file);
  assert.equal((await send(base, 'DELETE', `${path}/drafts/${id}`)).status, 200);
  assert.deepEqual((await reviewFileOf(base)).drafts, []);
  const missing = await send(base, 'PUT', `${path}/drafts/D9`, { text: 'x' });
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'rascunho desconhecido' }]);
  const bad = [['reviewed', { path: '', hash: H1, reviewed: true }], ['drafts', { anchor: { ...ANCHOR, end: 0 }, text: 'x' }], ['drafts', { anchor: ANCHOR, text: ' \u0007 ' }]] as const;
  for (const [name, body] of bad) assert.equal((await send(base, 'POST', `${path}/${name}`, body)).status, 400, JSON.stringify(body));
  assert.equal((await send(base, 'PUT', `${path}/body`, { body: 'x' })).status, 404, 'the review popover sends a summary: no stored general comment (#758)');
});

test('a PR without a task is read and keeps its review file: no task needs to hold the link (#758)', async (t) => {
  const { base, home } = await startPrs(t, fakeGh());
  assert.equal((await prOf(base, 8)).status, 200);
  const { id } = await (await send(base, 'POST', `${route(8)}/drafts`, { anchor: ANCHOR, text: 'look' })).json() as { id: string };
  assert.deepEqual((await reviewFileOf(base, OTHER_PR)).drafts, [{ id, anchor: ANCHOR, text: 'look' }]);
  await access(prReviewPath(home, OTHER_PR));
  await send(base, 'POST', `${route(9)}/drafts`, { anchor: ANCHOR, text: 'x' });
  await access(prReviewPath(home, PR2));
  assert.equal((await send(base, 'POST', '/tasks/local%3A2/close')).status, 200);
  await until(() => access(prReviewPath(home, PR2)).then(() => false, () => true));
});

test('taskOfPr: the task of the live activity whose record lists the link, else the first task one of whose records lists it, else none (#758)', () => {
  const task = (n: number): Task => ({ item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: '', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true });
  const prs = { prs: [{ url: PR, state: 'open' as const }] };
  const kept = withKeptRecord({ ...initialState(0), tasks: [task(1), task(2)] }, 'local:1', 'r1', prs); // task 1's activity was deleted
  assert.equal(taskOfPr(kept, PR)?.item.itemId, 'local:1');
  const live = withWork(kept, 'local:2', {}, prs); // task 2's live activity lists it too: it wins
  assert.equal(taskOfPr(live, PR)?.item.itemId, 'local:2');
  assert.equal(taskOfPr(live, OTHER_PR), undefined);
});

test('GET …/checks answers the stored checks, the merge state and updatedAt, with no GitHub call; a PR the model lacks is 404 (#758, #187)', async (t) => {
  const gh = fakeGh();
  const { base, db } = await startPrs(t, gh);
  db.setPullChecks(prKey(7), [{ name: 'test', state: 'pending', url: null, startedAt: AT, at: null }]);
  const before = gh.calls.length;
  const res = await hiveFetch(`${base}${route()}/checks`);
  assert.deepEqual(await res.json(), { mergeState: 'clean', updatedAt: AT, checks: { state: 'pending', items: [{ name: 'test', state: 'pending', startedAt: AT }] } });
  assert.equal(PAGE_CALLS(gh, before).length, 0, 'no GitHub call');
  assert.equal((await hiveFetch(`${base}${route(10)}/checks`)).status, 404);
});

test('a PR in conflict lists its conflicted files from its task\'s worktree; a task with no worktree, or no task, has none (#758)', async (t) => {
  const gh = fakeGh();
  gh.git = () => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: 'f00d\na.txt\n' }); };
  const { base, db } = await startPrs(t, gh, undefined, { worktree: true });
  for (const n of [7, 8, 9]) db.setPullPoll(prKey(n), { headSha: HEAD, mergeState: 'conflicts', checks: null });
  assert.deepEqual((await (await prOf(base)).json() as PrData).conflicts, ['a.txt']);
  assert.equal('conflicts' in (await (await prOf(base, 9)).json() as PrData), false, 'task 2 has no live activity, so no worktree');
  assert.equal('conflicts' in (await (await prOf(base, 8)).json() as PrData), false, 'no task');
});

