import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { taskOfPr } from '../src/activities.js';
import { DIFF_MAX_BYTES, fileHash, parseDiff } from '../src/diff.js';
import { initialState } from '../src/orchestrator.js';
import { prReviewPath } from '../src/pr-review-store.js';
import type { PrData, Task } from '../src/types.js';
import { withKeptRecord, withWork } from './fixtures/work.js';
import { ANCHOR, AT, DIFF, fakeGh, HEAD, namedEventDuring, OTHER_PR, PR, PR2, reviewFileOf, startPrs, until } from './pr-server.js';
import { fakeLog } from './fakes.js';
import { send } from './review-server.js';
import { hiveFetch } from './secret-client.js';

const H1 = 'b'.repeat(64);
// task 1 holds #7 (PR), task 2 #9 (PR2), no task #8 (OTHER_PR)
const route = (n = 7, repository = 'acme/app'): string => `/repositories/${repository}/pulls/${n}`;
const prOf = (base: string, n = 7, repository = 'acme/app'): Promise<Response> => hiveFetch(`${base}${route(n, repository)}`);
const PAGE = { body: 'The description', author: 'bia', createdAt: AT, updatedAt: AT, headRef: 'feature', baseRef: 'main', commits: 1, additions: 1, deletions: 1, approvals: 0, canEdit: true, canPush: true, headOwner: 'acme', baseOwner: 'acme', reviews: [], comments: [], reviewRequests: [] };

test('GET /repositories/:owner/:name/pulls/:number answers the PR, its diff with hashes, its conversations and its page\'s fields; an unlisted repository is 404, a malformed number 400 (#592, #758)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const res = await prOf(base);
  const data = await res.json() as PrData;
  assert.equal(res.status, 200);
  assert.deepEqual({ ...data, files: data.files.map((f) => [f.path, f.hash]) }, {
    url: PR, id: 'PR_1', number: 7, title: 'The PR', state: 'open', isDraft: false, mergeState: 'clean', head: HEAD, methods: ['merge', 'squash'], viewer: 'ana',
    truncated: false, files: [['a.txt', fileHash(parseDiff(DIFF)[0])]], ...PAGE,
    threads: [{
      id: 'T1', anchor: { path: 'a.txt', side: 'new', start: 1, end: 1 }, outdated: false, resolved: false, subject: 'line', more: false,
      comments: [{ id: 'C1', author: 'bia', at: AT, text: 'why?' }],
    }],
  });
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/pulls/7 -H Accept: application/vnd.github.diff'), 'the diff through gh api, argv only');
  const unlisted = await prOf(base, 7, 'acme/other');
  assert.deepEqual([unlisted.status, await unlisted.json()], [404, { error: 'repository is not one the Hive lists' }]);
  for (const n of ['07', '1e2', 'x']) assert.equal((await hiveFetch(`${base}/repositories/acme/app/pulls/${n}`)).status, 400, n);
});

test('GET …/pulls/:number reads the head again after the diff: a head that moved is read once more, a second move is 409 (#592)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  gh.heads = [HEAD, 'c'.repeat(40)]; // read 1: before the PR query, then after the diff, a newer head
  assert.equal((await prOf(base)).status, 200);
  assert.equal(gh.calls.filter((c) => c.args[1] !== 'graphql').length, 2, 'the diff read twice');
  gh.heads = [HEAD, 'c'.repeat(40), HEAD, 'd'.repeat(40)];
  const moved = await prOf(base);
  assert.deepEqual([moved.status, await moved.json()], [409, { error: 'o PR mudou durante a leitura, atualize' }]);
});

test('GET …/pulls/:number past #270\'s 5 MB cap answers its 413 (#592)', async (t) => {
  const gh = fakeGh();
  gh.diff = `${DIFF}${'+x\n'.repeat(Math.ceil(DIFF_MAX_BYTES / 3) + 1)}`;
  const { base } = await startPrs(t, gh);
  const res = await prOf(base);
  assert.deepEqual([res.status, await res.json()], [413, { error: 'diff grande demais para o visualizador' }]);
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

test('GET …/pulls/:number drops the marks whose file changed or left the diff; a task that leaves the State takes its PRs\' files (#592)', async (t) => {
  const { base, home } = await startPrs(t, fakeGh());
  const hash = fileHash(parseDiff(DIFF)[0]);
  for (const [path, value] of [['a.txt', H1], ['gone.txt', hash]]) await send(base, 'POST', `${route()}/reviewed`, { path, hash: value, reviewed: true });
  assert.equal((await prOf(base)).status, 200);
  await until(async () => (await reviewFileOf(base)).reviewed.length === 0);
  await send(base, 'POST', `${route()}/reviewed`, { path: 'a.txt', hash, reviewed: true });
  await prOf(base);
  await sleep(50);
  assert.deepEqual((await reviewFileOf(base)).reviewed, [{ path: 'a.txt', hash }], 'the matching mark stays');
  await send(base, 'POST', `${route(9)}/drafts`, { anchor: ANCHOR, text: 'x' });
  await access(prReviewPath(home, PR2));
  assert.equal((await send(base, 'POST', '/tasks/local%3A2/close')).status, 200);
  await until(() => access(prReviewPath(home, PR2)).then(() => false, () => true));
});

test('a PR without a task is read and keeps its review file: no task needs to hold the link (#758)', async (t) => {
  const { base, home } = await startPrs(t, fakeGh());
  assert.equal((await prOf(base, 8)).status, 200);
  const { id } = await (await send(base, 'POST', `${route(8)}/drafts`, { anchor: ANCHOR, text: 'look' })).json() as { id: string };
  assert.deepEqual((await reviewFileOf(base, OTHER_PR)).drafts, [{ id, anchor: ANCHOR, text: 'look' }]);
  await access(prReviewPath(home, OTHER_PR));
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

test('GET …/pulls?state= answers the repository\'s rows and counts; another state is 400, an unlisted repository 404 (#758)', async (t) => {
  const { base } = await startPrs(t, fakeGh());
  const res = await hiveFetch(`${base}/repositories/acme/app/pulls?state=open`);
  assert.deepEqual([res.status, await res.json()], [200, {
    rows: [{ url: PR, number: 7, title: 'The PR', state: 'open', isDraft: false, mergeState: 'clean', updatedAt: AT }], counts: { open: 2, merged: 1, closed: 0 }, truncated: false, canPush: true,
  }]);
  assert.equal((await hiveFetch(`${base}/repositories/acme/app/pulls?state=draft`)).status, 400);
  assert.equal((await hiveFetch(`${base}/repositories/acme/other/pulls?state=open`)).status, 404);
});

test('GET …/checks answers only the checks, the merge state and updatedAt, with no diff read (#758)', async (t) => {
  const gh = fakeGh();
  const running = { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null, completedAt: null };
  gh.pr = { ...gh.pr, headCommit: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { nodes: [running] } } } }] } };
  const { base } = await startPrs(t, gh);
  const res = await hiveFetch(`${base}${route()}/checks`);
  assert.deepEqual(await res.json(), { mergeState: 'clean', updatedAt: AT, checks: { state: 'pending', items: [{ name: 'test', state: 'pending' }] } });
  assert.equal(gh.calls.some((c) => c.args[1] !== 'graphql'), false, 'no diff read');
});

test('a PR in conflict lists its conflicted files from its task\'s worktree; a task with no worktree, or no task, has none (#758)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, mergeStateStatus: 'DIRTY' };
  gh.git = () => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: 'f00d\na.txt\n' }); };
  const { base } = await startPrs(t, gh, undefined, { worktree: true });
  assert.deepEqual((await (await prOf(base)).json() as PrData).conflicts, ['a.txt']);
  assert.equal('conflicts' in (await (await prOf(base, 9)).json() as PrData), false, 'task 2 has no live activity, so no worktree');
  assert.equal('conflicts' in (await (await prOf(base, 8)).json() as PrData), false, 'no task');
});

test('a PR from a fork reads how far its base moved from REST\'s compare, which GitHub\'s GraphQL answers null for (#854)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, headRepositoryOwner: { login: 'me' } };
  gh.compare = JSON.stringify({ behind_by: 3 });
  const { base } = await startPrs(t, gh);
  const data = await (await prOf(base)).json() as PrData;
  assert.deepEqual([data.behindBy, data.headOwner, data.baseOwner, data.canPush], [3, 'me', 'acme', true]);
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/compare/main...me:feature'));
});

test('the REST compare of a fork encodes the branch names it puts in the path (#854)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, headRepositoryOwner: { login: 'me' }, headRefName: 'fix/a?b', baseRefName: 'rel/1' };
  gh.compare = JSON.stringify({ behind_by: 1 });
  const { base } = await startPrs(t, gh);
  await prOf(base);
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/compare/rel%2F1...me:fix%2Fa%3Fb'));
});

test('a GitHub refusal of the PR read is a 502 that leaves its message in hive.log by the PR\'s number; a 404 leaves no line (#849)', async (t) => {
  const gh = fakeGh();
  const { log, lines } = fakeLog();
  const { base } = await startPrs(t, gh, log);
  gh.readFailWith = "Could not resolve head ref 'feature'";
  const refused = await prOf(base);
  assert.deepEqual([refused.status, await refused.json()], [502, { error: "gh api graphql: Could not resolve head ref 'feature'" }]);
  const warned = (): string[] => lines.filter((line) => line.startsWith('WARN pr #7:'));
  assert.deepEqual(warned(), ["WARN pr #7: GitHub refused the read: gh api graphql: Could not resolve head ref 'feature'"]);
  gh.readFailWith = undefined;
  gh.missing = true;
  assert.equal((await prOf(base)).status, 404);
  assert.equal(warned().length, 1, 'a PR GitHub does not find is no refusal');
});

test('a merged PR from a fork asks no REST compare: a PR that is not open has no behindBy (#849)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, state: 'MERGED', headRepositoryOwner: { login: 'me' } };
  gh.compare = JSON.stringify({ behind_by: 3 });
  const { base } = await startPrs(t, gh);
  const data = await (await prOf(base)).json() as PrData;
  assert.deepEqual([data.state, 'behindBy' in data], ['merged', false]);
  assert.equal(gh.calls.some((c) => c.args[1]?.includes('/compare/')), false);
});
