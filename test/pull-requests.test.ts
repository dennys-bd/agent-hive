import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_FIELDS, hasOpenPr, mergeOrderBlocker, nextPr, NO_PR_SEEN, openPrUrls, parsePrActivity, parsePrStates, prActivityQuery, prActivityRecords, prGroups, prNumber, prRepo, prStatesQuery, repoName, withPrStates } from '../src/pull-requests.js';
import type { ActivityRecord, PrSlice, PrState, TaskPr } from '../src/types.js';

const PR = 'https://github.com/o/r/pull/';
// The PRs live in the activity's record (#629)
const record = (n: number, prs?: TaskPr[]): ActivityRecord => ({ id: `a${n}`, taskIds: [`board:item${n}`], sessions: [], ...(prs ? { prs } : {}) });
const open = (n: number): TaskPr => ({ url: `${PR}${n}`, state: 'open' });

test('openPrUrls lists every open PR across the records once, in record order, skipping merged and closed ones and a record with none; hasOpenPr asks the same of one list (#207, #629)', () => {
  const records = [record(1, [{ url: `${PR}7`, state: 'merged' }, open(8)]), record(2), record(3, [open(9), { url: `${PR}10`, state: 'closed' }, open(8)])];
  assert.deepEqual(openPrUrls(records), [`${PR}8`, `${PR}9`]);
  assert.deepEqual(openPrUrls([record(1, [{ url: `${PR}7`, state: 'merged' }])]), [], 'no open PR: nothing to ask');
  assert.deepEqual(records.map((r) => hasOpenPr(r.prs)), [true, false, true]);
  assert.equal(hasOpenPr([{ url: `${PR}7`, state: 'closed' }]), false);
  assert.equal(hasOpenPr(undefined), false, 'a worker with no task');
});

test('prStatesQuery asks each PR for its state and times only; prActivityQuery, a query of its own, for its commits and check runs; one aliased resource per link inlined as a JSON string (#207, #742)', () => {
  assert.equal(prStatesQuery([]), undefined);
  assert.equal(prActivityQuery([]), undefined);
  assert.equal(
    prStatesQuery([`${PR}8`, `${PR}9`]),
    `query { p0: resource(url: "${PR}8") { ... on PullRequest { state createdAt mergedAt closedAt } } p1: resource(url: "${PR}9") { ... on PullRequest { state createdAt mergedAt closedAt } } }`,
  );
  assert.equal(prActivityQuery([`${PR}8`]), `query { p0: resource(url: "${PR}8") { ... on PullRequest { ${ACTIVITY_FIELDS} } } }`);
  assert.ok(!ACTIVITY_FIELDS.includes('state '), 'the activity read never carries the state the merge detection reads');
  assert.ok(ACTIVITY_FIELDS.includes('recent: commits(last: 100) { nodes { commit { oid committedDate } } }'), 'each recent commit\'s sha, for pr.commit');
  assert.ok(ACTIVITY_FIELDS.includes('checkRuns(last: 50, filterBy: { checkType: ALL })'), 'every attempt of a check, a re-run too, the newest kept when there are many: a failure then a pass is flaky');
  assert.ok(prStatesQuery(['https://x/"){ viewer { login } }#'])?.includes('"https://x/\\"){ viewer { login } }#"'), 'a quote cannot close the string');
});

test('parsePrStates reads OPEN (a draft included), MERGED and CLOSED by alias; a null, missing or odd alias and an unknown state are left out (#207)', () => {
  const urls = [7, 8, 9, 10, 11, 12, 13].map((n) => `${PR}${n}`);
  const data = { p0: { state: 'OPEN' }, p1: { state: 'MERGED' }, p2: { state: 'CLOSED' }, p3: null, p5: 'x', p6: { state: 'DRAFT' } }; // p4 missing
  assert.deepEqual(parsePrStates(urls, data), [{ url: `${PR}7`, state: 'open' }, { url: `${PR}8`, state: 'merged' }, { url: `${PR}9`, state: 'closed' }]);
  assert.deepEqual(parsePrStates(urls, null), []);
  assert.deepEqual(parsePrStates([`${PR}7`], { p0: { state: 'constructor' } }), [], 'an inherited name is no state');
});

test('withPrStates gives each record\'s PRs the states read and returns a record with nothing new as the same object; prNumber reads the number off the link (#207, #629)', () => {
  const one = record(1, [open(7), open(8)]);
  const two = record(2, [open(9)]);
  const bare = record(3);
  const [a, b, c] = withPrStates([one, two, bare], [{ url: `${PR}7`, state: 'merged' }, { url: `${PR}9`, state: 'open' }]);
  assert.deepEqual(a.prs, [{ url: `${PR}7`, state: 'merged' }, open(8)]);
  assert.equal(a.prs?.[1], one.prs?.[1], 'an untouched PR is the same object');
  assert.equal(one.prs?.[0].state, 'open', 'the input is not mutated');
  assert.equal(b, two, 'the same state: the same record');
  assert.equal(c, bare);
  assert.deepEqual([prNumber(`${PR}42`), prNumber(`${PR}42/files`), prNumber('x')], ['42', '42', 'x']);
});

const APP = 'https://github.com/acme/app/pull/';
const SITE = 'https://github.com/acme/site/pull/';
const pr = (url: string, state: PrState, slice?: PrSlice): TaskPr => ({ url, state, ...(slice ? { slice } : {}) });
const stacked = (k: number): PrSlice => ({ k, type: 'stacked' });

test('prGroups orders a stack by k and the PRs without a slice after it by number, counts its slices and merges, and derives each base: the previous slice in stacked, the integration PR in integration (#698)', () => {
  // slice 2 reopened as #12 after #11 was opened as slice 3; #5 has no slice
  const prs = [pr(`${APP}11`, 'open', stacked(3)), pr(`${APP}5`, 'closed'), pr(`${APP}10`, 'merged', stacked(1)), pr(`${APP}12`, 'open', stacked(2))];
  const [app] = prGroups(prs, 'acme/app');
  assert.deepEqual(app.lines.map((l) => [prNumber(l.pr.url), l.position, l.base && prNumber(l.base)]), [
    ['10', { k: 1, total: 3 }, undefined], ['12', { k: 2, total: 3 }, '10'], ['11', { k: 3, total: 3 }, '12'], ['5', undefined, undefined],
  ]);
  assert.deepEqual([app.repo, app.type, app.merged, app.slices, app.own], ['acme/app', 'stacked', 1, 3, true]);
  const [integration] = prGroups([1, 2, 3].map((k) => pr(`${APP}${20 + k}`, 'open', { k, type: 'integration' })));
  assert.deepEqual(integration.lines.map((l) => l.base), [`${APP}23`, `${APP}23`, undefined], 'every slice targets the integration PR, which targets the base');
  assert.equal(integration.type, 'integration');
  assert.deepEqual(prGroups([pr(`${APP}7`, 'open')])[0], { repo: 'acme/app', lines: [{ pr: pr(`${APP}7`, 'open') }], merged: 0, slices: 0, own: true });
});

test('prGroups puts the task\'s repository first and the others in arrival order, falls back to the first PR\'s repository, and keeps each url once with its later entry (#698)', () => {
  const prs = [pr(`${SITE}3`, 'open'), pr(`${APP}7`, 'open', stacked(1)), pr('https://github.com/acme/docs/pull/1', 'open'), pr(`${APP}7`, 'merged', stacked(1))];
  assert.deepEqual(prGroups(prs, 'acme/app').map((g) => [g.repo, g.own]), [['acme/app', true], ['acme/site', false], ['acme/docs', false]]);
  assert.deepEqual(prGroups(prs).map((g) => g.repo), ['acme/site', 'acme/app', 'acme/docs'], 'a local task: its first PR\'s repository is its own');
  assert.deepEqual(prGroups(prs, 'acme/other').map((g) => g.own), [true, false, false], 'no PR in the task\'s repository: the same fallback');
  assert.deepEqual(prGroups(prs, 'acme/app')[0].lines.map((l) => l.pr.state), ['merged'], 'the later record\'s entry wins');
  assert.deepEqual(prGroups([], 'acme/app'), []);
  assert.equal(prRepo(`${SITE}3`), 'acme/site');
  assert.equal(repoName('acme/site'), 'site');
});

test('nextPr is the own repository\'s first open PR in merge order, else the task\'s newest; mergeOrderBlocker names the first open slice before a PR in its group (#698)', () => {
  const stack = [pr(`${APP}10`, 'merged', stacked(1)), pr(`${APP}11`, 'open', stacked(2)), pr(`${APP}12`, 'open', stacked(3)), pr(`${SITE}3`, 'open')];
  assert.equal(nextPr(stack, 'acme/app'), `${APP}11`, 'slice 1 merged: slice 2, not the newest');
  assert.equal(nextPr([pr(`${APP}7`, 'merged'), pr(`${APP}8`, 'open')]), `${APP}8`, 'no slice: the first open one by number');
  assert.equal(nextPr([pr(`${APP}8`, 'merged'), pr(`${APP}7`, 'closed')], 'acme/app'), `${APP}7`, 'nothing open: the newest');
  assert.equal(nextPr([], 'acme/app'), undefined);
  assert.equal(mergeOrderBlocker(stack, `${APP}12`), `${APP}11`);
  assert.equal(mergeOrderBlocker(stack, `${APP}11`), undefined, 'the slice before it merged');
  assert.equal(mergeOrderBlocker([pr(`${APP}10`, 'closed', stacked(1)), pr(`${APP}11`, 'open', stacked(2))], `${APP}11`), undefined, 'closed is not open');
  assert.equal(mergeOrderBlocker([...stack, pr(`${SITE}2`, 'open')], `${SITE}3`), undefined, 'no slice: never blocked');
});

test('parsePrStates keeps createdAt, mergedAt and closedAt as openedAt, mergedAt and closedAt; a missing or odd one is left out (#742)', () => {
  const data = { p0: { state: 'MERGED', createdAt: '2026-10-01T10:00:00Z', mergedAt: '2026-10-02T10:00:00Z', closedAt: '2026-10-02T10:00:00Z' }, p1: { state: 'OPEN', createdAt: 'soon', mergedAt: null } };
  assert.deepEqual(parsePrStates([`${PR}7`, `${PR}8`], data), [
    { url: `${PR}7`, state: 'merged', openedAt: '2026-10-01T10:00:00Z', mergedAt: '2026-10-02T10:00:00Z', closedAt: '2026-10-02T10:00:00Z' },
    { url: `${PR}8`, state: 'open' },
  ]);
});

const checkRun = (databaseId: number, name: string, conclusion: string | null) =>
  ({ databaseId, name, conclusion, startedAt: '2026-10-03T12:00:00Z', completedAt: '2026-10-03T12:01:30Z' });
const withChecks = (commits: number, runs: unknown[], dates: string[] = []) => ({
  createdAt: '2026-10-03T10:00:00Z', commits: { totalCount: commits }, recent: { nodes: dates.map((committedDate, i) => ({ commit: { oid: `c${i}0000000000000`, committedDate } })) },
  headCommit: { nodes: [{ commit: { oid: 'abcdef1234567890', checkSuites: { nodes: [{ checkRuns: { nodes: runs } }] } } }] },
});

test('parsePrActivity reads the commit count, the commits after the PR opened from GitHub\'s dates and the head commit\'s concluded check runs, the sha cut to 8; a run still going or an odd node is left out (#742)', () => {
  const dates = ['2026-10-03T09:00:00Z', '2026-10-03T11:00:00Z', '2026-10-03T12:00:00Z'];
  const data = { p0: withChecks(3, [checkRun(11, 'lint', 'SUCCESS'), checkRun(12, 'test', null), { databaseId: 'x' }], dates), p1: null, p2: { commits: { totalCount: 1 }, recent: { nodes: [null, { commit: { oid: 7 } }, { commit: { oid: 'ffff00001111', committedDate: 'soon' } }] } } };
  const recent = dates.map((committedAt, i) => ({ sha: `c${i}000000`, committedAt }));
  assert.deepEqual(parsePrActivity([`${PR}7`, `${PR}8`, `${PR}9`], data), [
    { url: `${PR}7`, commits: 3, afterOpen: 2, recent, checks: [{ id: 11, name: 'lint', conclusion: 'success', sha: 'abcdef12', durationMs: 90_000 }] },
    { url: `${PR}9`, commits: 1, recent: [], checks: [] },
  ]);
});

test('prActivityRecords writes each check run once by id and the commit count when it changes, with GitHub\'s after_open; what it keeps is pruned to the open PRs (#742)', () => {
  const ids = (url: string) => ({ task_id: url.endsWith('/7') ? 'board:I1' : 'board:I2' });
  const open = [`${PR}7`];
  const c1 = { sha: 'aaaa1111', committedAt: '2026-10-03T11:00:00Z' };
  const c2 = { sha: 'bbbb2222', committedAt: '2026-10-03T12:00:00Z' };
  const first = prActivityRecords([{ url: `${PR}7`, commits: 2, afterOpen: 1, recent: [c1], checks: [{ id: 11, name: 'test', conclusion: 'failure', sha: 'abcdef12', durationMs: 5 }] }], NO_PR_SEEN, ids, open);
  assert.deepEqual(first.records, [
    { event: 'pr.checks', level: 'info', task_id: 'board:I1', pr: 7, sha: 'abcdef12', check_run_id: 11, name: 'test', conclusion: 'failure', duration_ms: 5 },
    { event: 'pr.commit', level: 'info', task_id: 'board:I1', pr: 7, sha: 'aaaa1111', committed_at: '2026-10-03T11:00:00Z' },
    { event: 'pr.commits', level: 'info', task_id: 'board:I1', pr: 7, count: 2, after_open: 1 },
  ]);
  const again = prActivityRecords([{ url: `${PR}7`, commits: 2, afterOpen: 1, recent: [c1], checks: [{ id: 11, name: 'test', conclusion: 'failure', sha: 'abcdef12' }, { id: 12, name: 'test', conclusion: 'success', sha: 'abcdef12' }] }], first.seen, ids, open);
  assert.deepEqual(again.records.map((r) => r.event), ['pr.checks'], 'run 11, commit aaaa1111 and the same count are not written again');
  const pushed = prActivityRecords([{ url: `${PR}7`, commits: 5, afterOpen: 4, recent: [c1, c2], checks: [] }], again.seen, ids, open);
  assert.deepEqual(pushed.records, [
    { event: 'pr.commit', level: 'info', task_id: 'board:I1', pr: 7, sha: 'bbbb2222', committed_at: '2026-10-03T12:00:00Z' },
    { event: 'pr.commits', level: 'info', task_id: 'board:I1', pr: 7, count: 5, after_open: 4 },
  ]);
  assert.deepEqual(prActivityRecords([], pushed.seen, ids, []).seen, {}, 'a PR no longer open is forgotten');
  assert.deepEqual(NO_PR_SEEN, {}, 'what was seen is a copy');
});

test('withPrStates stores the times the poll read; a read with nothing new keeps the same record (#742)', () => {
  const [stored] = withPrStates([record(1, [open(7)])], [{ url: `${PR}7`, state: 'open', openedAt: '2026-10-01T10:00:00Z' }]);
  assert.deepEqual(stored.prs, [{ url: `${PR}7`, state: 'open', openedAt: '2026-10-01T10:00:00Z' }]);
  const [same] = withPrStates([stored], [{ url: `${PR}7`, state: 'open', openedAt: '2026-10-01T10:00:00Z' }]);
  assert.equal(same, stored);
});
