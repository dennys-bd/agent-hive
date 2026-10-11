import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, resultOf, withActivity } from '../src/activities.js';
import { deriveEvents } from '../src/event-derive.js';
import { describeEffect, describeEvent } from '../src/log.js';
import { initialState, reduce, type Reduced } from '../src/orchestrator.js';
import { savedWork } from '../src/state-guards.js';
import { startMode } from '../src/task-runs.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, CiCheck, CiPrRead, Effect, HiveEvent, Item, SourceItem, Stage, State, Transition } from '../src/types.js';
import { chained } from './fakes.js';

// A wait-for-CI stage (#834): the reducer's side, end to end through reduce. The task is polled into the stage under red, so no fill spawns
// anything and every effect below is the stage's own. A check's state is #758's: success, failure or pending.

const ID = 'board:item1';
const URL = 'https://github.com/o/r/pull/7';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const listed = (column: string, extra: Partial<Item> = {}): SourceItem => ({ item: { ...item, ...extra }, column });
const ci = (extra: Partial<Stage> = {}): LegacyStage => ({ name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: false, ...extra });
const REVIEW: LegacyStage = { name: 'review', from: { board: ['Review'] } };
const base = (extra: Partial<Stage> = {}, state: Partial<State> = {}): State =>
  ({ ...initialState(1), signal: 'red', workspaces: ['hive'], syncs: { board: {} }, ...chained([ci(extra), REVIEW]), ...state });
const polled = (extra: Partial<Stage> = {}, state: Partial<State> = {}): Reduced => reduce(base(extra, state), { type: 'poll', source: 'board', items: [listed('CI')] });
const live = (s: State): Activity | undefined => activityOf(s, ID);
const check = (name: string, state: CiCheck['state'], extra: Partial<CiCheck> = {}): CiCheck => ({ name, pr: URL, state, ...extra });
const pr = (checks: CiCheck[], head = 'h1'): CiPrRead => ({ url: URL, head, checks });
const readOf = (s: State, prs: CiPrRead[], at = new Date().toISOString()): Extract<HiveEvent, { type: 'ciRead' }> =>
  ({ type: 'ciRead', activityId: live(s)?.id ?? 'none', at, prs });
const read = (s: State, prs: CiPrRead[], at?: string): Reduced => reduce(s, readOf(s, prs, at));
const failedOf = (s: State, names: string[], output = 'logs'): Reduced => reduce(s, { type: 'ciFailed', activityId: live(s)?.id ?? 'none', names, output });
const effectOf = <T extends Effect['type']>(effects: Effect[], type: T): Extract<Effect, { type: T }> | undefined =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);
const LATER = '2100-01-01T00:00:00Z'; // a failure completed after any re-run the tests ask
const outputOf = (s: State): unknown => (resultOf(s, ID)?.ci as { output?: unknown } | undefined)?.output;
// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

test('a due task in a wait-for-CI stage starts waiting: ci on its activity, one ciRead effect, no worker, no worktree; it is not due again (#834)', () => {
  const { state, effects } = polled();
  const wait = live(state)?.ci;
  assert.ok(wait);
  assert.deepEqual([wait.stage, wait.reran, Number.isFinite(Date.parse(wait.since))], ['ci', [], true]);
  assert.deepEqual(effects.filter((e) => e.type === 'ciRead'), [{ type: 'ciRead', activityId: live(state)?.id }]);
  assert.equal(state.workers.every((w) => w.status === 'empty'), true, 'waiting holds no worker');
  assert.equal(live(state)?.worktree, undefined);
  assert.equal(effectOf(reduce(state, { type: 'poll', source: 'board', items: [listed('CI')] }).effects, 'ciRead'), undefined);
});

test('a read still running keeps the task waiting with its count; no open PR reads as waiting for one; a read that changes nothing keeps the activity (#834)', () => {
  const none = read(polled().state, []).state;
  assert.deepEqual([live(none)?.ci?.waitingPr, live(none)?.ci?.total], [true, 0]);
  const running = read(none, [pr([check('build', 'success'), check('test', 'pending')])]);
  assert.deepEqual([running.state.tasks[0].stage, live(running.state)?.ci?.done, live(running.state)?.ci?.total, live(running.state)?.ci?.waitingPr], ['ci', 1, 2, undefined]);
  assert.deepEqual(running.effects, []);
  assert.equal(live(read(running.state, [pr([check('build', 'success'), check('test', 'pending')])]).state), live(running.state), 'nothing new to save');
});

test('every check a success merges passed into the record, drops the wait and moves the task on (#834)', () => {
  const { state } = read(polled().state, [pr([check('build', 'success'), check('docs', 'success')])]);
  assert.deepEqual([state.tasks[0].stage, live(state)?.ci, live(state)?.stopped], ['review', undefined, undefined]);
  assert.deepEqual(resultOf(state, ID)?.ci, { verdict: 'passed' });
});

test('with rerunOnce a failure re-runs its Actions runs, each once, and keeps waiting; the same head failing again fetches the logs (#834)', () => {
  const s = polled({ rerunOnce: true }).state;
  const first = read(s, [pr([check('build', 'failure', { runId: 11 }), check('test', 'failure', { runId: 11 }), check('lint', 'pending')])]);
  assert.deepEqual(effectOf(first.effects, 'ciRerun'), { type: 'ciRerun', activityId: live(s)?.id, runs: [{ repo: 'o/r', runId: 11 }] });
  assert.deepEqual([live(first.state)?.ci?.reran, live(first.state)?.stopped, first.state.tasks[0].stage], [['h1'], undefined, 'ci']);
  const again = read(first.state, [pr([check('build', 'failure', { runId: 12, at: LATER })])]);
  assert.equal(effectOf(again.effects, 'ciRerun'), undefined);
  assert.deepEqual(effectOf(again.effects, 'ciCollect')?.failed, [check('build', 'failure', { runId: 12, at: LATER })]);
  assert.equal(live(again.state)?.ci?.collecting, true);
});

test('after a re-run, a failure GitHub has not flipped to pending yet reads as pending for five minutes; one completed after the re-run fails (#834)', () => {
  const asked = '2026-10-07T12:00:00.000Z';
  const first = read(polled({ rerunOnce: true }).state, [pr([check('build', 'failure', { runId: 11, at: '2026-10-07T11:59:00Z' })])], asked).state;
  assert.equal(live(first)?.ci?.rerunAt, asked);
  for (const old of [check('build', 'failure', { runId: 11, at: '2026-10-07T11:59:00Z' }), check('build', 'failure', { runId: 11 })]) {
    const stale = read(first, [pr([old])], '2026-10-07T12:00:30.000Z');
    assert.deepEqual([stale.effects, live(stale.state)?.ci?.done, live(stale.state)?.ci?.total, live(stale.state)?.ci?.collecting], [[], 0, 1, undefined]);
  }
  const failed = read(first, [pr([check('build', 'failure', { runId: 11, at: '2026-10-07T12:04:00Z' })])], '2026-10-07T12:05:00.000Z');
  assert.deepEqual(effectOf(failed.effects, 'ciCollect')?.failed.map((c) => c.name), ['build']);
  const refused = read(first, [pr([check('build', 'failure', { runId: 11, at: '2026-10-07T11:59:00Z' })])], '2026-10-07T12:06:00.000Z');
  assert.ok(effectOf(refused.effects, 'ciCollect'), 'a re-run that never started fails once the grace is over');
});

test('a new head after a re-run gets its own re-run (#834)', () => {
  const first = read(polled({ rerunOnce: true }).state, [pr([check('build', 'failure', { runId: 11 })])]).state;
  const pushed = read(first, [pr([check('build', 'failure', { runId: 21 })], 'h2')]);
  assert.deepEqual(effectOf(pushed.effects, 'ciRerun')?.runs, [{ repo: 'o/r', runId: 21 }]);
  assert.deepEqual(live(pushed.state)?.ci?.reran, ['h1', 'h2']);
});

test('a failure with no Actions run behind it cannot be re-run: the logs are fetched at once, rerunOnce or not (#834)', () => {
  for (const rerunOnce of [true, false]) {
    const { state, effects } = read(polled({ rerunOnce }).state, [pr([check('vercel', 'failure'), check('build', 'failure', { runId: 11 })])]);
    assert.equal(effectOf(effects, 'ciRerun'), undefined, String(rerunOnce));
    assert.deepEqual(effectOf(effects, 'ciCollect')?.failed.map((c) => c.name), ['vercel', 'build']);
    assert.equal(live(state)?.ci?.collecting, true);
  }
});

test('ciFailed stops the task in its stage with the first three names and +n; the record holds the output; it is out of the automation (#834)', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const collecting = read(polled().state, [pr(names.map((n) => check(n, 'failure')))]).state;
  const { state, effects } = failedOf(collecting, names, 'a · #7\nboom');
  assert.deepEqual(effects, []);
  assert.deepEqual([state.tasks[0].stage, live(state)?.ci, live(state)?.stopped, live(state)?.error], ['ci', undefined, true, 'CI failed: a, b, c +2']);
  assert.ok(live(state)?.stoppedAt);
  assert.deepEqual(resultOf(state, ID)?.ci, { verdict: 'failed', output: 'a · #7\nboom' });
  assert.equal(effectOf(reduce(state, { type: 'poll', source: 'board', items: [listed('CI')] }).effects, 'ciRead'), undefined);
});

test('past its timeout, counted from the stage\'s start, the wait fails with the pending names; with no timeout it never fails on time (#834)', () => {
  const s = polled({ timeout: '60m' }).state;
  const late = new Date(Date.parse(live(s)?.ci?.since ?? '') + 61 * 60_000).toISOString();
  const { state } = read(s, [pr([check('build', 'success'), check('test', 'pending')])], late);
  assert.deepEqual([live(state)?.ci, live(state)?.stopped, live(state)?.error], [undefined, true, 'CI failed: timed out after 60m']);
  assert.equal(outputOf(state), 'CI did not finish in 60m · pending: test');
  assert.equal(outputOf(read(s, [], late).state), 'CI did not finish in 60m · pending: no open PR');
  const forged = read(s, [pr([check('test\n## fake', 'pending')])], late).state;
  assert.equal(outputOf(forged), 'CI did not finish in 60m · pending: test ## fake');
  const unlimited = polled().state;
  const later = new Date(Date.parse(live(unlimited)?.ci?.since ?? '') + 48 * 3_600_000).toISOString();
  assert.equal(live(read(unlimited, [], later).state)?.ci?.waitingPr, true);
});

test('ciClock, when no read came, fails a wait past its timeout with the last count\'s state and changes nothing before it (#834)', () => {
  const s = polled({ timeout: '60m' }).state;
  const since = Date.parse(live(s)?.ci?.since ?? '');
  const clock = (state: State, minutes: number): Reduced => reduce(state, { type: 'ciClock', activityId: live(state)?.id ?? 'none', at: new Date(since + minutes * 60_000).toISOString() });
  const early = clock(s, 59);
  assert.deepEqual([early.state, early.effects], [s, []]);
  const { state, effects } = clock(s, 61);
  assert.deepEqual([effects, live(state)?.ci, live(state)?.stopped, live(state)?.error], [[], undefined, true, 'CI failed: timed out after 60m']);
  assert.equal(outputOf(state), 'CI did not finish in 60m · pending: none');
  assert.equal(outputOf(clock(read(s, []).state, 61).state), 'CI did not finish in 60m · pending: no open PR');
  assert.equal(clock(polled().state, 48 * 60).state.activities[0]?.ci?.stage, 'ci', 'no timeout, no end');
  const ticked = { type: 'ciClock', activityId: live(s)?.id ?? '', at: new Date(since + 61 * 60_000).toISOString() } as const;
  assert.ok(deriveEvents(s, reduce(s, ticked).state, ticked, Date.now()).some((r) => r.event === 'ci.ended' && r.verdict === 'failed'));
  assert.equal(describeEvent({ type: 'ciClock', activityId: 'abcdef123456', at: 'x' }), 'ciClock activity=abcdef12');
  reduce(deepFreeze(polled({ timeout: '1m' }).state), { ...ticked, at: '2100-01-01T00:00:00.000Z' });
});

test('a read while the logs are fetched, a read for another activity and ciFailed with no fetch under way change nothing (#834)', () => {
  const s = polled().state;
  const collecting = read(s, [pr([check('build', 'failure')])]).state;
  const after = read(collecting, [pr([check('build', 'success')])]);
  assert.deepEqual([live(after.state), after.effects], [live(collecting), []]);
  assert.equal(live(reduce(s, { ...readOf(s, [pr([check('build', 'success')])]), activityId: 'other' }).state), live(s));
  assert.equal(live(failedOf(s, ['build']).state), live(s), 'no fetch under way');
});

test('during a Quit neither a read nor ciFailed acts (#834)', () => {
  const quitting = reduce(polled().state, { type: 'quit' }).state;
  assert.equal(live(read(quitting, [pr([check('build', 'success')])]).state), live(quitting));
  const fetching = reduce(read(polled().state, [pr([check('build', 'failure')])]).state, { type: 'quit' }).state;
  assert.equal(live(failedOf(fetching, ['build']).state), live(fetching));
});

test('a manual start of a failed wait starts over with no re-run spent and the error cleared; one already waiting is ignored (#834)', () => {
  const reran = read(polled({ rerunOnce: true }).state, [pr([check('build', 'failure', { runId: 11 })])]).state;
  const failed = failedOf(read(reran, [pr([check('build', 'failure', { runId: 11, at: LATER })])]).state, ['build']).state;
  const { state, effects } = reduce(failed, { type: 'start', itemId: ID });
  assert.deepEqual([live(state)?.error, live(state)?.stopped, live(state)?.ci?.reran], [undefined, undefined, []]);
  assert.ok(effectOf(effects, 'ciRead'));
  assert.deepEqual(reduce(state, { type: 'start', itemId: ID }).effects, [], 'already waiting');
});

test('auto off or an after not yet passed keeps the wait from starting (#834)', () => {
  assert.equal(effectOf(reduce(base(), { type: 'poll', source: 'board', items: [listed('CI', { autoOnEntry: false })] }).effects, 'ciRead'), undefined);
  assert.equal(effectOf(polled({ after: '5d' }).effects, 'ciRead'), undefined);
});

test('a waiting task cannot be moved by hand or by its source column, and offers no start (#834)', () => {
  const s = polled().state;
  assert.equal(reduce(s, { type: 'moveToStage', taskId: ID, stage: 'review' }).state.tasks[0].stage, 'ci');
  assert.equal(reduce(s, { type: 'poll', source: 'board', items: [listed('Review')] }).state.tasks[0].stage, 'ci');
  assert.equal(startMode(s.tasks[0], s), 'running');
});

test('the wait\'s rules never mutate the state they are given (#834)', () => {
  const frozen = deepFreeze(polled({ rerunOnce: true, timeout: '1m' }).state);
  read(frozen, []);
  read(frozen, [pr([check('build', 'success')])]);
  read(frozen, [pr([check('build', 'failure', { runId: 1 })])]);
  read(frozen, [pr([check('build', 'pending')])], '2100-01-01T00:00:00.000Z');
  const collecting = deepFreeze(read(polled().state, [pr([check('build', 'failure')])]).state);
  failedOf(collecting, ['build']);
  reduce(deepFreeze(failedOf(read(polled().state, [pr([check('build', 'failure')])]).state, ['build']).state), { type: 'start', itemId: ID });
});

test('the log names a read by its PRs\' numbers and a failure by its checks\' names, never the output (#834)', () => {
  assert.equal(describeEvent({ type: 'ciRead', activityId: 'abcdef123456', at: 'x', prs: [pr([])] }), 'ciRead activity=abcdef12 prs=#7');
  assert.equal(describeEvent({ type: 'ciRead', activityId: 'abcdef123456', at: 'x', prs: [] }), 'ciRead activity=abcdef12 prs=-');
  const failed = describeEvent({ type: 'ciFailed', activityId: 'abcdef123456', names: ['build', 'test'], output: 'secret log' });
  assert.equal(failed, 'ciFailed activity=abcdef12 failed=build,test');
  assert.equal(describeEffect({ type: 'ciRerun', activityId: 'abcdef123456', runs: [{ repo: 'o/r', runId: 11 }] }), 'ciRerun activity=abcdef12 runs=11');
  assert.equal(describeEffect({ type: 'ciCollect', activityId: 'abcdef123456', failed: [check('build', 'failure')] }), 'ciCollect activity=abcdef12 failed=build');
  assert.equal(describeEffect({ type: 'ciRead', activityId: 'abcdef123456' }), 'ciRead activity=abcdef12');
});

test('deleting the activity drops the wait with no verdict and leaves the activity stopped (#834)', () => {
  const s0 = polled().state;
  const s = withActivity(s0, { ...(live(s0) as Activity), worktree: '/wt/hive-1-task-1' });
  const { state } = reduce(s, { type: 'deletingActivity', activityId: live(s)?.id ?? '' });
  assert.deepEqual([live(state)?.ci, live(state)?.stopped, live(state)?.deleting, resultOf(state, ID)?.ci], [undefined, true, true, undefined]);
});

test('a boot keeps the wait, after a crash and after a Quit, and drops only an unfinished log fetch, so the next read decides again (#834)', () => {
  const waiting = polled().state;
  const collecting = read(waiting, [pr([check('build', 'failure')])]).state;
  for (const before of [waiting, collecting, reduce(collecting, { type: 'quit' }).state]) {
    const booted = reduce(before, { type: 'boot' }).state;
    assert.deepEqual([live(booted)?.ci?.stage, live(booted)?.ci?.collecting, live(booted)?.stopped], ['ci', undefined, undefined]);
  }
  const again = read(reduce(collecting, { type: 'boot' }).state, [pr([check('build', 'failure')])]);
  assert.ok(effectOf(again.effects, 'ciCollect'));
});

test('a saved activity keeps its wait so the boot reads on; a malformed one reads as none and collecting is never read (#834)', () => {
  const wait = { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: ['h1'], rerunAt: '2026-10-07T10:05:00.000Z', done: 1, total: 2, fellBack: true };
  assert.deepEqual(savedWork({ ci: { ...wait, collecting: true } }).ci, wait);
  const bare = { stage: 'ci', since: wait.since, reran: [], waitingPr: true };
  assert.deepEqual(savedWork({ ci: bare }).ci, bare);
  for (const bad of [{ ...wait, since: 'soon' }, { ...wait, reran: 'h1' }, { ...wait, stage: 1 }, 'x']) assert.equal(savedWork({ ci: bad }).ci, undefined, JSON.stringify(bad));
});

test('a delete and a boot never mutate the state they are given (#834)', () => {
  const frozen = deepFreeze(withActivity(polled().state, { ...(live(polled().state) as Activity), worktree: '/wt/x' }));
  reduce(frozen, { type: 'deletingActivity', activityId: live(frozen)?.id ?? '' });
  reduce(frozen, { type: 'boot' });
  reduce(frozen, { type: 'closeTask', taskId: ID });
});

test('the event log writes a required wait\'s fallback once, a wait\'s end with its verdict and how long it waited, and a passed wait\'s move as on_finish (#834)', () => {
  const s = polled({ ciChecks: 'required' }).state;
  const first = readOf(s, [pr([check('build', 'pending')])]); // no required list: every check counts
  const fell = reduce(s, first).state;
  assert.equal(deriveEvents(s, fell, first, Date.now()).filter((r) => r.event === 'ci.fallback').length, 1);
  const second = readOf(fell, [pr([check('build', 'pending'), check('lint', 'pending')])]);
  assert.equal(deriveEvents(fell, reduce(fell, second).state, second, Date.now()).some((r) => r.event === 'ci.fallback'), false, 'once per wait');
  const pass = readOf(fell, [pr([check('build', 'success')])]);
  const passed = deriveEvents(fell, reduce(fell, pass).state, pass, Date.now());
  assert.ok(passed.some((r) => r.event === 'ci.ended' && r.verdict === 'passed' && r.level === 'info' && r.duration_ms >= 0));
  assert.match(JSON.stringify(passed), /"event":"task.moved"[^}]*"by":"on_finish"/);
  const collecting = read(polled().state, [pr([check('build', 'failure')])]).state;
  const fail: HiveEvent = { type: 'ciFailed', activityId: live(collecting)?.id ?? '', names: ['build'], output: 'x' };
  assert.ok(deriveEvents(collecting, reduce(collecting, fail).state, fail, Date.now()).some((r) => r.event === 'ci.ended' && r.verdict === 'failed' && r.level === 'warn'));
});

test('stopCi ends the wait, stopped, with no verdict, and is ignored where nothing waits; a read after it does nothing; the log names the activity (#834)', () => {
  const s = polled().state;
  const { state, effects } = reduce(s, { type: 'stopCi', activityId: live(s)?.id ?? '' });
  assert.deepEqual(effects, []);
  assert.deepEqual([live(state)?.ci, live(state)?.stopped, state.tasks[0].stage, resultOf(state, ID)?.ci], [undefined, true, 'ci', undefined]);
  assert.equal(live(reduce(state, { type: 'stopCi', activityId: live(state)?.id ?? '' }).state), live(state));
  assert.equal(live(read(state, [pr([check('build', 'success')])]).state), live(state), 'a late read finds no wait');
  assert.equal(describeEvent({ type: 'stopCi', activityId: 'abcdef123456' }), 'stopCi activity=abcdef12');
  const frozen = deepFreeze(polled().state);
  reduce(frozen, { type: 'stopCi', activityId: live(frozen)?.id ?? '' });
});

test('a read whose workflows await a maintainer\'s approval keeps waiting with ci.awaiting, writes nothing more while it holds, drops it on a read without any, and still times out (#854)', () => {
  const s = polled({ timeout: '10m' }).state;
  const since = live(s)?.ci?.since ?? '';
  const awaiting = read(s, [{ ...pr([]), awaiting: ['CI', 'Lint'] }]);
  assert.deepEqual([awaiting.effects, live(awaiting.state)?.ci?.awaiting, awaiting.state.tasks[0].stage], [[], 2, 'ci']);
  assert.equal(live(read(awaiting.state, [{ ...pr([]), awaiting: ['CI', 'Lint'] }]).state), live(awaiting.state), 'nothing new to save');
  assert.equal(live(read(awaiting.state, [pr([check('build', 'pending')])]).state)?.ci?.awaiting, undefined);
  const late = new Date(Date.parse(since) + 11 * 60_000).toISOString();
  const timedOut = read(awaiting.state, [{ ...pr([]), awaiting: ['CI'] }], late);
  assert.equal(live(timedOut.state)?.stopped, true);
  assert.match(String(outputOf(timedOut.state)), /pending: CI \(awaiting approval\)/);
});

test('with rerunOnce and no push rights a failure re-runs nothing and fetches nothing: ci.noRerun and the wait goes on; a read gone pending drops it; without rerunOnce it fails as before (#854)', () => {
  const s = polled({ rerunOnce: true }).state;
  const failing = [{ ...pr([check('build', 'failure', { runId: 11 })]), canPush: false }];
  const held = read(s, failing);
  assert.deepEqual([held.effects, live(held.state)?.ci?.noRerun, live(held.state)?.stopped, held.state.tasks[0].stage], [[], true, undefined, 'ci']);
  assert.equal(live(read(held.state, failing).state), live(held.state), 'nothing new to save');
  const pushed = read(held.state, [{ ...pr([check('build', 'pending')], 'h2'), canPush: false }]);
  assert.equal(live(pushed.state)?.ci?.noRerun, undefined);
  assert.ok(effectOf(read(polled().state, failing).effects, 'ciCollect'), 'no rerunOnce: the logs and the failure, as #834');
});

test('a saved wait keeps its awaiting count and its noRerun mark (#854)', () => {
  const ci = { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: [], awaiting: 2, noRerun: true };
  assert.deepEqual(savedWork({ ci }).ci, ci);
  assert.deepEqual(savedWork({ ci: { ...ci, awaiting: -1, noRerun: 'yes' } }).ci, { stage: 'ci', since: ci.since, reran: [] });
});

test('a failed wait with a failed transition takes it with the logs on the record; the task leaves the stage instead of stopping (#134)', () => {
  const back: Transition = { from: 'ci', to: 'review', when: 'verdict', verdict: 'failed' };
  const waiting = polled({}, { transitions: [...chained([ci(), REVIEW]).transitions, back] }).state;
  const collecting = read(waiting, [pr([check('build', 'failure', { runId: 1, at: LATER })])]).state;
  const { state } = failedOf(collecting, ['build'], 'build log');
  assert.deepEqual([state.tasks[0].stage, live(state)?.ci, live(state)?.stopped, outputOf(state)], ['review', undefined, undefined, 'build log']);
});

test('a read writes the considered checks for the running block; a check that changes state writes them again; the same read twice keeps the activity (#914)', () => {
  const T0 = '2026-10-10T10:00:00Z';
  const build = check('build', 'success', { startedAt: T0, at: '2026-10-10T10:01:30Z' });
  const running = [build, check('test', 'pending', { startedAt: '2026-10-10T10:02:00Z' }), check('lint', 'pending')];
  const first = read(polled().state, [pr(running)]).state;
  assert.deepEqual(live(first)?.ci?.checks, [
    { name: 'build', state: 'success', startedAt: T0, completedAt: '2026-10-10T10:01:30Z' },
    { name: 'test', state: 'pending', startedAt: '2026-10-10T10:02:00Z' },
    { name: 'lint', state: 'pending' },
  ]);
  assert.equal(live(read(first, [pr(running)]).state), live(first), 'nothing new to save');
  const moved = read(first, [pr([build, check('test', 'success', { startedAt: '2026-10-10T10:02:00Z', at: '2026-10-10T10:04:00Z' }), check('lint', 'pending')])]).state;
  assert.deepEqual(live(moved)?.ci?.checks?.map((c) => [c.name, c.state]), [['build', 'success'], ['test', 'success'], ['lint', 'pending']]);
});

test('a failure re-run keeps its ✕ line on the wait while the re-run is awaited; the input is never mutated (#914)', () => {
  const s = deepFreeze(polled({ rerunOnce: true }).state);
  const asked = read(s, [pr([check('build', 'failure', { runId: 11, startedAt: '2026-10-10T10:00:00Z', at: '2026-10-10T10:01:00Z' }), check('lint', 'pending')])]).state;
  assert.deepEqual(live(asked)?.ci?.checks?.map((c) => [c.name, c.state]), [['build', 'failure'], ['lint', 'pending']]);
  assert.deepEqual(live(asked)?.ci?.reran, ['h1']);
});
