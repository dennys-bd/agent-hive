import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { DIFF_MAX_BYTES, fileHash, parseDiff } from '../src/diff.js';
import type { PullChangesRow } from '../src/read-model/rows.js';
import type { PrChanges } from '../src/types.js';
import { fakeLog } from './fakes.js';
import { AT, DIFF, fakeGh, type FakeGh, HEAD, PR, PR_PAGE_ROW, namedEventDuring, PR_SOURCE, prKey, reviewFileOf, seedPr, startPrs, thread, until } from './pr-server.js';
import { send } from './review-server.js';
import { hiveFetch } from './secret-client.js';

const H1 = 'b'.repeat(64);
const changesOf = (base: string, n = 7, query = ''): Promise<Response> => hiveFetch(`${base}/repositories/acme/app/pulls/${n}/changes${query}`);
const queryOf = (call: { args: string[] }): string => call.args.find((arg) => arg.startsWith('query=')) ?? '';
// The page's four reads by kind; the poll's PR states (#207) and the writes are none of them
function kindOf(call: { args: string[] }): string | undefined {
  if (call.args.at(-1) === 'Accept: application/vnd.github.diff') return 'diff';
  if (call.args[1]?.includes('/compare/')) return 'compare';
  if (call.args[1]?.includes('/timeline')) return 'timeline';
  return call.args[1] === 'graphql' && queryOf(call).includes('reviewThreads') ? 'threads' : undefined;
}
const reads = (gh: FakeGh, from = 0): string[] => gh.calls.slice(from).flatMap((c) => kindOf(c) ?? []).sort();
const rowOf = (db: { prChanges: (s: string, r: string, n: number) => PullChangesRow | undefined }, n = 7) => db.prChanges(PR_SOURCE, 'acme/app', n);
const THREAD = {
  id: 'T1', anchor: { path: 'a.txt', side: 'new' as const, start: 1, end: 1 }, outdated: false, resolved: false, subject: 'line' as const, more: false,
  comments: [{ id: 'C1', author: 'bia', at: AT, text: 'why?' }],
};

test('GET …/changes with no row reads the diff, the threads, the compare and the timeline, answers them, and stores the open PR\'s row (#497)', async (t) => {
  const gh = fakeGh();
  const { base, db } = await startPrs(t, gh);
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, requested: [{ reviewer: 'ana', team: false }] });
  gh.compare = JSON.stringify({ behind_by: 2 });
  gh.timeline = JSON.stringify({ at: AT, user: 'ana', team: null });
  const before = gh.calls.length;
  const res = await changesOf(base);
  const data = await res.json() as PrChanges;
  assert.equal(res.status, 200);
  assert.deepEqual({ ...data, files: data.files.map((f) => [f.path, f.hash]) }, {
    head: HEAD, files: [['a.txt', fileHash(parseDiff(DIFF)[0])]], threads: [THREAD], truncated: false, behindBy: 2,
    reviewRequests: [{ reviewer: 'ana', team: false, viewer: true, at: AT }],
  });
  assert.deepEqual(reads(gh, before), ['compare', 'diff', 'threads', 'timeline']);
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/pulls/7 -H Accept: application/vnd.github.diff'), 'the diff through gh api, argv only');
  assert.deepEqual(rowOf(db), { head: HEAD, diff: DIFF, threads: [THREAD], truncated: false, behindBy: 2, requestTimes: [{ reviewer: 'ana', team: false, at: AT }] });
});

test('GET …/changes of a PR that is not open answers and stores nothing (#497)', async (t) => {
  const { base, db } = await startPrs(t, fakeGh());
  seedPr(db, 7, { state: 'closed', closedAt: AT });
  assert.equal((await changesOf(base)).status, 200);
  assert.equal(rowOf(db), undefined);
});

test('GET …/changes checks the model\'s head against the threads\' headRefOid: a moved head is refetched and read once more, a second move is 409 (#592, #187, #497)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  gh.heads = ['c'.repeat(40)]; // read 1's threads answer a newer head, read 2's the model's
  assert.equal((await changesOf(base)).status, 200);
  assert.equal(reads(gh).filter((r) => r === 'diff').length, 2, 'the diff read twice');
  gh.heads = ['c'.repeat(40), 'd'.repeat(40)];
  const moved = await changesOf(base, 8); // PR 7 now has its row at the model's head
  assert.deepEqual([moved.status, await moved.json()], [409, { error: 'o PR mudou durante a leitura, atualize' }]);
});

test('GET …/changes whose head differs after a refetch that failed answers at the threads\' head, not 409: the diff matches that head (#187, #497)', async (t) => {
  const gh = fakeGh();
  gh.rest = async () => { throw new Error('gh api: HTTP 502'); };
  const { base } = await startPrs(t, gh);
  const newer = 'c'.repeat(40);
  gh.heads = [newer, newer];
  const res = await changesOf(base);
  assert.deepEqual([res.status, (await res.json() as PrChanges).head], [200, newer]);
});

test('GET …/changes past #270\'s 5 MB cap answers its 413 and stores nothing (#592, #497)', async (t) => {
  const gh = fakeGh();
  gh.diff = `${DIFF}${'+x\n'.repeat(Math.ceil(DIFF_MAX_BYTES / 3) + 1)}`;
  const { base, db } = await startPrs(t, gh);
  const res = await changesOf(base);
  assert.deepEqual([res.status, await res.json()], [413, { error: 'diff grande demais para o visualizador' }]);
  assert.equal(rowOf(db), undefined);
});

test('a GitHub refusal of the changes is a 502 that leaves its message in hive.log by the PR\'s number; a PR the model lacks is 404 with no line (#849, #497)', async (t) => {
  const gh = fakeGh();
  const { log, lines } = fakeLog();
  const { base } = await startPrs(t, gh, log);
  gh.readFailWith = "Could not resolve head ref 'feature'";
  const refused = await changesOf(base);
  assert.deepEqual([refused.status, await refused.json()], [502, { error: "gh api graphql: Could not resolve head ref 'feature'" }]);
  const warned = (): string[] => lines.filter((line) => line.startsWith('WARN pr #7:'));
  assert.deepEqual(warned(), ["WARN pr #7: GitHub refused the read: gh api graphql: Could not resolve head ref 'feature'"]);
  gh.readFailWith = undefined;
  const missing = await changesOf(base, 10);
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'PR não encontrado' }]);
  assert.equal(warned().length, 1);
});

test('GET …/changes leaves a debug line by the PR\'s number, never its link, when the compare or the timeline fails; the times are only dropped (#187, #497)', async (t) => {
  const gh = fakeGh();
  const { log, lines } = fakeLog();
  const { base, db } = await startPrs(t, gh, log);
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, requested: [{ reviewer: 'ana', team: false }] });
  gh.compare = 'not json';
  gh.timelineFailWith = 'gh api: HTTP 502';
  const data = await (await changesOf(base)).json() as PrChanges;
  assert.deepEqual([data.reviewRequests, 'behindBy' in data], [[{ reviewer: 'ana', team: false, viewer: true }], false]);
  const debug = lines.filter((line) => line.startsWith('DEBUG pr #7:'));
  assert.equal(debug.filter((line) => line.includes('compare')).length, 1);
  assert.equal(debug.filter((line) => line.includes('timeline')).length, 1);
  assert.ok(debug.every((line) => line.includes('Error') && !line.includes(PR)), debug.join('\n'));
});

test('a PR from a fork reads behindBy from REST\'s compare, the branch names encoded in the path (#854, #497)', async (t) => {
  const gh = fakeGh();
  gh.compare = JSON.stringify({ behind_by: 3 });
  const { base, db } = await startPrs(t, gh);
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, headOwner: 'me', headRef: 'fix/a?b', baseRef: 'rel/1' });
  assert.equal((await (await changesOf(base)).json() as PrChanges).behindBy, 3);
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/compare/rel%2F1...me:fix%2Fa%3Fb'));
});

test('an open PR from its own repository reads behindBy from REST\'s compare too (#187, #497)', async (t) => {
  const gh = fakeGh();
  gh.compare = JSON.stringify({ behind_by: 2 });
  const { base } = await startPrs(t, gh);
  assert.equal((await (await changesOf(base)).json() as PrChanges).behindBy, 2);
  assert.ok(gh.calls.some((c) => c.args.join(' ') === 'api repos/acme/app/compare/main...acme:feature'));
});

test('a merged PR asks no REST compare: a PR that is not open has no behindBy (#849, #497)', async (t) => {
  const gh = fakeGh();
  gh.compare = JSON.stringify({ behind_by: 3 });
  const { base, db } = await startPrs(t, gh);
  seedPr(db, 7, { state: 'closed', closedAt: AT });
  db.setPullFlags({ ...prKey(7), draft: false, mergedAt: AT });
  db.setPullPage(prKey(7), { ...PR_PAGE_ROW, headOwner: 'me' });
  assert.equal('behindBy' in (await (await changesOf(base)).json() as PrChanges), false);
  assert.equal(gh.calls.some((c) => c.args[1]?.includes('/compare/')), false);
});

test('GET …/changes drops the marks whose file changed or left the diff; the matching mark stays (#592, #497)', async (t) => {
  const { base } = await startPrs(t, fakeGh());
  const hash = fileHash(parseDiff(DIFF)[0]);
  const path = '/repositories/acme/app/pulls/7';
  for (const [file, value] of [['a.txt', H1], ['gone.txt', hash]]) await send(base, 'POST', `${path}/reviewed`, { path: file, hash: value, reviewed: true });
  assert.equal((await changesOf(base)).status, 200);
  await until(async () => (await reviewFileOf(base)).reviewed.length === 0);
  await send(base, 'POST', `${path}/reviewed`, { path: 'a.txt', hash, reviewed: true });
  await changesOf(base);
  await sleep(50);
  assert.deepEqual((await reviewFileOf(base)).reviewed, [{ path: 'a.txt', hash }]);
});

const STORED: PullChangesRow = { head: HEAD, diff: DIFF, threads: [THREAD], truncated: false, requestTimes: [] };

test('a row at the model\'s head answers with no diff call, then revalidates the threads and the compare behind it; an unchanged read leaves the row (#497)', async (t) => {
  const gh = fakeGh();
  const { base, db } = await startPrs(t, gh);
  db.setPrChanges(PR_SOURCE, 'acme/app', 7, STORED);
  const before = gh.calls.length;
  const res = await changesOf(base);
  assert.deepEqual((await res.json() as PrChanges).threads, [THREAD]);
  await until(async () => reads(gh, before).length === 2);
  assert.deepEqual(reads(gh, before), ['compare', 'threads'], 'no diff; no timeline, since no request is pending');
  assert.deepEqual(rowOf(db), STORED);
});

test('a revalidation whose threads changed stores them and sends readModel with pullChanges; the diff is not read again (#497)', async (t) => {
  const gh = fakeGh();
  const { base, db } = await startPrs(t, gh);
  db.setPrChanges(PR_SOURCE, 'acme/app', 7, STORED);
  gh.pr = { ...gh.pr, reviewThreads: { totalCount: 1, nodes: [thread({ isResolved: true })] } };
  const before = gh.calls.length;
  const event = await namedEventDuring(base, 'readModel', () => changesOf(base));
  assert.deepEqual(event, { type: 'readModel', repository: 'acme/app', kinds: ['pullChanges'] });
  assert.equal(rowOf(db)?.threads[0]?.resolved, true);
  assert.equal(reads(gh, before).includes('diff'), false);
});

test('a revalidation whose threads answer another head refetches and reads the diff before storing (#497)', async (t) => {
  const gh = fakeGh();
  const { base, db } = await startPrs(t, gh);
  db.setPrChanges(PR_SOURCE, 'acme/app', 7, STORED);
  const newer = 'c'.repeat(40);
  gh.heads = [newer];
  gh.diff = DIFF.replace('+two', '+three');
  const before = gh.calls.length;
  await changesOf(base);
  await until(async () => rowOf(db)?.head === newer);
  assert.equal(rowOf(db)?.diff, gh.diff);
  assert.equal(reads(gh, before).filter((r) => r === 'diff').length, 1);
});

test('a second open within the cooldown makes no GitHub call; fresh=1, the page\'s refresh after a write, revalidates past it (#497)', async (t) => {
  const gh = fakeGh();
  const { base, db } = await startPrs(t, gh);
  db.setPrChanges(PR_SOURCE, 'acme/app', 7, STORED);
  await changesOf(base);
  await until(async () => reads(gh).includes('threads'));
  await sleep(50); // the first revalidation settles
  const after = gh.calls.length;
  assert.equal((await changesOf(base)).status, 200);
  await sleep(50);
  assert.deepEqual(reads(gh, after), []);
  await changesOf(base, 7, '?fresh=1');
  await until(async () => reads(gh, after).includes('threads'));
});
