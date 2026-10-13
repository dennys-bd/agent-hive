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
import { ANCHOR, AT, DIFF, fakeGh, HEAD, namedEventDuring, OTHER_PR, PR, PR2, PR_PAGE_ROW, prKey, reviewFileOf, seedPr, startPrs, until } from './pr-server.js';
import { fakeLog } from './fakes.js';
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

test('GET /repositories/:owner/:name/pulls/:number answers the PR, its diff with hashes, its conversations and its page\'s fields; an unlisted repository is 404, a malformed number 400 (#592, #758)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const res = await prOf(base);
  const data = await res.json() as PrData;
  assert.equal(res.status, 200);
  assert.deepEqual({ ...data, files: data.files.map((f) => [f.path, f.hash]) }, {
    url: PR, id: 'PR_7', number: 7, title: 'The PR', state: 'open', isDraft: false, mergeState: 'clean', head: HEAD, methods: ['merge', 'squash'], viewer: 'ana',
    truncated: false, files: [['a.txt', fileHash(parseDiff(DIFF)[0])]], ...PAGE,
    threads: [{
      id: 'T1', anchor: { path: 'a.txt', side: 'new', start: 1, end: 1 }, outdated: false, resolved: false, subject: 'line', more: false,
      comments: [{ id: 'C1', author: 'bia', at: AT, text: 'why?' }],
    }],
  });
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/pulls/7 -H Accept: application/vnd.github.diff'), 'the diff through gh api, argv only');
  assert.equal(gh.calls.filter((c) => c.args[1] === 'graphql' && queryOf(c).includes('reviewThreads')).length, 1, 'the threads alone over GraphQL');
  const unlisted = await prOf(base, 7, 'acme/other');
  assert.deepEqual([unlisted.status, await unlisted.json()], [404, { error: 'repository is not one the Hive lists' }]);
  for (const n of ['07', '1e2', 'x']) assert.equal((await hiveFetch(`${base}/repositories/acme/app/pulls/${n}`)).status, 400, n);
});

test('GET …/pulls/:number checks the stored head against the threads\' headRefOid: a head that moved is refetched and read once more, a second move is 409 (#592, #187)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const diffs = (): number => gh.calls.filter((c) => c.args.at(-1) === 'Accept: application/vnd.github.diff').length;
  gh.heads = ['c'.repeat(40)]; // read 1's threads answer a newer head, read 2's the stored one
  assert.equal((await prOf(base)).status, 200);
  assert.equal(diffs(), 2, 'the diff read twice');
  gh.heads = ['c'.repeat(40), 'd'.repeat(40)];
  const moved = await prOf(base);
  assert.deepEqual([moved.status, await moved.json()], [409, { error: 'o PR mudou durante a leitura, atualize' }]);
});

test('GET …/pulls/:number answers the fields from the model even when every refetch fails; GitHub is read only for the threads, the diff and the compare (#187)', async (t) => {
  const gh = fakeGh();
  gh.rest = async () => { throw new Error('gh api: HTTP 502'); };
  const { base } = await startPrs(t, gh);
  const before = gh.calls.length;
  const res = await prOf(base);
  assert.deepEqual([res.status, (await res.json() as PrData).title], [200, 'The PR']);
  assert.deepEqual(PAGE_CALLS(gh, before).map((c) => c.args[1]).sort(), ['graphql', 'repos/acme/app/compare/main...acme:feature', 'repos/acme/app/pulls/7']);
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

test('a PR from a fork reads how far its base moved from REST\'s compare, which GitHub\'s GraphQL answers null for (#854)', async (t) => {
  const gh = fakeGh();
  gh.compare = JSON.stringify({ behind_by: 3 });
  const { base, db } = await startPrs(t, gh);
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, headOwner: 'me' });
  const data = await (await prOf(base)).json() as PrData;
  assert.deepEqual([data.behindBy, data.headOwner, data.baseOwner, data.canPush], [3, 'me', 'acme', true]);
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/compare/main...me:feature'));
});

test('the REST compare of a fork encodes the branch names it puts in the path (#854)', async (t) => {
  const gh = fakeGh();
  gh.compare = JSON.stringify({ behind_by: 1 });
  const { base, db } = await startPrs(t, gh);
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, headOwner: 'me', headRef: 'fix/a?b', baseRef: 'rel/1' });
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
  const missing = await prOf(base, 10);
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'PR não encontrado' }]);
  assert.equal(warned().length, 1, 'a PR the model does not hold is no refusal');
});

test('a merged PR from a fork asks no REST compare: a PR that is not open has no behindBy (#849)', async (t) => {
  const gh = fakeGh();
  gh.compare = JSON.stringify({ behind_by: 3 });
  const { base, db } = await startPrs(t, gh);
  seedPr(db, 7, { state: 'closed', closedAt: AT });
  db.setPullFlags({ ...prKey(7), draft: false, mergedAt: AT });
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, headOwner: 'me' });
  const data = await (await prOf(base)).json() as PrData;
  assert.deepEqual([data.state, 'behindBy' in data], ['merged', false]);
  assert.equal(gh.calls.some((c) => c.args[1]?.includes('/compare/')), false);
});

test('an open PR from its own repository reads behindBy from REST\'s compare too (#187)', async (t) => {
  const gh = fakeGh();
  gh.compare = JSON.stringify({ behind_by: 2 });
  const { base } = await startPrs(t, gh);
  assert.equal((await (await prOf(base)).json() as PrData).behindBy, 2);
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/compare/main...acme:feature'));
});

test('GET …/pulls/:number puts the timeline\'s latest review_requested time on each stored request; a timeline gh cannot read only drops the times (#67, #187)', async (t) => {
  const gh = fakeGh();
  const { base, db } = await startPrs(t, gh);
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, requested: [{ reviewer: 'ana', team: false }, { reviewer: 'core', team: true }] });
  gh.timeline = JSON.stringify({ at: AT, user: 'ana', team: null });
  const requests = async (): Promise<unknown> => (await (await prOf(base)).json() as PrData).reviewRequests;
  assert.deepEqual(await requests(), [{ reviewer: 'ana', team: false, viewer: true, at: AT }, { reviewer: 'core', team: true, viewer: false }]);
  assert.ok(gh.calls.some((c) => c.args.join(' ').startsWith('api repos/acme/app/issues/7/timeline?per_page=100 --paginate --jq ')));
  gh.timeline = 'not json';
  assert.deepEqual(await requests(), [{ reviewer: 'ana', team: false, viewer: true }, { reviewer: 'core', team: true, viewer: false }]);
});
