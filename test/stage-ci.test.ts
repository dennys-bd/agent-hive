import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultOf, withActivity } from '../src/activities.js';
import { deriveFacts } from '../src/fact-derive.js';
import { describeEffect, describeEvent } from '../src/log.js';
import { reduce } from '../src/orchestrator.js';
import { savedWork } from '../src/state-guards.js';
import { startMode } from '../src/task-runs.js';
import type { Activity, CiCheck, CiPrRead, HiveEvent, State, Transition } from '../src/types.js';
import { chained } from './fakes.js';
import { withWork } from './fixtures/work.js';
import { base, check, ci, deepFreeze, effectOf, failedOf, ID, LATER, listed, live, outputOf, polled, pr, read, readOf, REVIEW, URL, withPrs } from './fixtures/stage-ci.js';

// A wait-for-CI stage (#834): the reducer's side, end to end through reduce. The task is polled into the stage under red, so no fill spawns
// anything and every effect below is the stage's own. A check's state is #758's: success, failure or pending.

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

test('auto off no longer keeps the wait from starting; an after not yet passed still does (#834, #304)', () => {
  const off = reduce(base(), { type: 'poll', source: 'board', items: [listed('CI', { autoOnEntry: false })] });
  assert.equal(off.state.tasks[0].auto, false);
  assert.ok(effectOf(off.effects, 'ciRead'), 'the wait starts under auto off');
  assert.ok(live(off.state)?.ci);
  assert.equal(effectOf(polled({ after: '5d' }).effects, 'ciRead'), undefined);
});

test('a waiting task cannot be moved by hand or by its source column, and offers no start (#834)', () => {
  const s = polled().state;
  assert.equal(reduce(s, { type: 'moveToStage', taskId: ID, stage: 'review' }).state.tasks[0].stage, 'ci');
  assert.equal(reduce(s, { type: 'poll', source: 'board', items: [listed('Review')] }).state.tasks[0].stage, 'ci');
  assert.equal(startMode(s.tasks[0], s), 'running');
});

test('the wait\'s rules never mutate the state they are given (#834)', () => {
  const frozen = deepFreeze(polled({ rerunOnce: true, timeout: '1m', queueTimeout: '1m' }).state);
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
  assert.equal(deriveFacts(s, fell, first, Date.now()).filter((r) => r.event === 'ci.fallback').length, 1);
  const second = readOf(fell, [pr([check('build', 'pending'), check('lint', 'pending')])]);
  assert.equal(deriveFacts(fell, reduce(fell, second).state, second, Date.now()).some((r) => r.event === 'ci.fallback'), false, 'once per wait');
  const pass = readOf(fell, [pr([check('build', 'success')])]);
  const passed = deriveFacts(fell, reduce(fell, pass).state, pass, Date.now());
  assert.ok(passed.some((r) => r.event === 'ci.ended' && r.verdict === 'passed' && r.level === 'info' && r.duration_ms >= 0));
  assert.match(JSON.stringify(passed), /"event":"task.moved"[^}]*"by":"on_finish"/);
  const collecting = read(polled().state, [pr([check('build', 'failure')])]).state;
  const fail: HiveEvent = { type: 'ciFailed', activityId: live(collecting)?.id ?? '', names: ['build'], output: 'x' };
  assert.ok(deriveFacts(collecting, reduce(collecting, fail).state, fail, Date.now()).some((r) => r.event === 'ci.ended' && r.verdict === 'failed' && r.level === 'warn'));
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

test('a read whose workflows await a maintainer\'s approval keeps waiting with ci.awaiting, writes nothing more while it holds, drops it on a read without any, and still ends on queueTimeout (#854, #598)', () => {
  const s = polled({ queueTimeout: '10m' }).state;
  const since = live(s)?.ci?.since ?? '';
  const awaiting = read(s, [{ ...pr([]), awaiting: ['CI', 'Lint'] }]);
  assert.deepEqual([awaiting.effects, live(awaiting.state)?.ci?.awaiting, awaiting.state.tasks[0].stage], [[], 2, 'ci']);
  assert.equal(live(read(awaiting.state, [{ ...pr([]), awaiting: ['CI', 'Lint'] }]).state), live(awaiting.state), 'nothing new to save');
  assert.equal(live(read(awaiting.state, [pr([check('build', 'pending')])]).state)?.ci?.awaiting, undefined);
  const moved = read(awaiting.state, [{ ...pr([check('build', 'pending')]), awaiting: ['CI', 'Lint'] }]);
  assert.deepEqual(live(moved.state)?.ci?.checks?.map((c) => c.name), ['build'], '#914: a held wait still refreshes the block\'s checks');
  const late = new Date(Date.parse(since) + 11 * 60_000).toISOString();
  const timedOut = read(awaiting.state, [{ ...pr([]), awaiting: ['CI'] }], late);
  assert.equal(live(timedOut.state)?.stopped, true);
  assert.match(String(outputOf(timedOut.state)), /CI \(awaiting approval\) \(queued over 10m\)/);
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

test('a failed wait\'s try names every failed check as its cause and the log\'s first line as its error (#915)', () => {
  const back: Transition = { from: 'ci', to: 'review', when: 'verdict', verdict: 'failed', maxTries: 2 };
  const waiting = polled({}, { transitions: [...chained([ci(), REVIEW]).transitions, back] }).state;
  const collecting = read(waiting, [pr([check('build', 'failure', { runId: 1, at: LATER }), check('test', 'failure', { runId: 1, at: LATER })])]).state;
  const { state } = failedOf(collecting, ['build', 'test'], '\nbuild log\nmore');
  const [{ cause, error, n, stage }] = live(state)?.tryLog ?? [];
  assert.deepEqual({ cause, error, n, stage }, { cause: 'build, test', error: 'build log', n: 1, stage: 'review' });
});

const conflicting = (checks: CiCheck[] = []): CiPrRead => ({ ...pr(checks), base: 'main', conflicting: true });
const CONFLICT = 'PR #7 conflicts with main: update the branch from main and resolve the conflicts, then push.';

test('a read where a PR conflicts with its base fails the wait at once: a failed transition takes the task with the conflict as its cause; no re-run, no log fetch (#264)', () => {
  const back: Transition = { from: 'ci', to: 'review', when: 'verdict', verdict: 'failed', maxTries: 2 };
  const waiting = polled({ rerunOnce: true }, { transitions: [...chained([ci(), REVIEW]).transitions, back] }).state;
  const { state, effects } = read(waiting, [conflicting([check('build', 'failure', { runId: 11 })])]);
  assert.equal(effectOf(effects, 'ciRerun'), undefined);
  assert.equal(effectOf(effects, 'ciCollect'), undefined);
  assert.deepEqual([state.tasks[0].stage, live(state)?.ci, live(state)?.stopped, outputOf(state)], ['review', undefined, undefined, CONFLICT]);
  const [{ cause, stage }] = live(state)?.tryLog ?? [];
  assert.deepEqual({ cause, stage }, { cause: 'conflict with main', stage: 'review' });
});

test('without a failed transition a conflict stops the task with CI failed: conflict with <base>, even past the timeout; no base read names the base branch; a PR not conflicting keeps waiting (#264)', () => {
  const s = polled({ timeout: '10m' }).state;
  const stopped = read(s, [conflicting()]).state;
  assert.deepEqual([stopped.tasks[0].stage, live(stopped)?.ci, live(stopped)?.stopped, live(stopped)?.error], ['ci', undefined, true, 'CI failed: conflict with main']);
  assert.deepEqual(resultOf(stopped, ID)?.ci, { verdict: 'failed', output: CONFLICT });
  const late = new Date(Date.parse(live(s)?.ci?.since ?? '') + 11 * 60_000).toISOString();
  assert.equal(live(read(s, [conflicting()], late).state)?.error, 'CI failed: conflict with main', 'the conflict is the cause, not the timeout');
  const { base: _base, ...unread } = conflicting();
  assert.equal(outputOf(read(s, [unread]).state), 'PR #7 conflicts with the base branch: update the branch from the base branch and resolve the conflicts, then push.');
  const waiting = read(s, [{ ...pr([check('build', 'pending')]), base: 'main' }]);
  assert.deepEqual([waiting.effects, waiting.state.tasks[0].stage, live(waiting.state)?.ci?.total, live(waiting.state)?.stopped], [[], 'ci', 1, undefined]);
});

test('ci.ended says failed for a failure a transition routes and for one that stops the task, and passed for a pass (#264)', () => {
  const ended = (s: State, prs: CiPrRead[]): unknown[] => {
    const event = readOf(s, prs);
    return deriveFacts(s, reduce(s, event).state, event, Date.now()).flatMap((r) => (r.event === 'ci.ended' ? [[r.verdict, r.level]] : []));
  };
  const back: Transition = { from: 'ci', to: 'review', when: 'verdict', verdict: 'failed' };
  const routing = polled({}, { transitions: [...chained([ci(), REVIEW]).transitions, back] }).state;
  assert.deepEqual(ended(routing, [conflicting()]), [['failed', 'warn']]);
  assert.deepEqual(ended(polled().state, [conflicting()]), [['failed', 'warn']]);
  assert.deepEqual(ended(polled().state, [pr([check('build', 'success')])]), [['passed', 'info']]);
});

test('a read with no open PR passes the wait once every PR of the task is merged; one closed without merge, or no PR at all, keeps it waiting for one (#304)', () => {
  const waiting = polled().state;
  const DOCS = 'https://github.com/o/docs/pull/102';
  const merged = read(withPrs(waiting, [{ url: URL, state: 'merged' }, { url: DOCS, state: 'merged' }]), []);
  assert.deepEqual([merged.state.tasks[0].stage, live(merged.state)?.ci, live(merged.state)?.stopped], ['review', undefined, undefined], 'the passed transition takes it on');
  assert.deepEqual(resultOf(merged.state, ID)?.ci, { verdict: 'passed' });
  const dropped = read(withPrs(waiting, [{ url: URL, state: 'merged' }, { url: DOCS, state: 'closed' }]), []).state;
  assert.deepEqual([dropped.tasks[0].stage, live(dropped)?.ci?.waitingPr], ['ci', true], 'a PR closed without merge is no delivery');
  const bare = read(waiting, []).state;
  assert.deepEqual([bare.tasks[0].stage, live(bare)?.ci?.waitingPr], ['ci', true], 'no PR yet: waiting for one, as before');
});

// #381: a task that entered the wait while a session of the user's held it starts waiting as that session ends, not on the next poll
test('a session ending on a task held in a wait-for-CI stage starts the wait in that reduction: exit, SessionEnd and spawnFailed; a /clear does not (#381)', () => {
  const polledIn = reduce(base(), { type: 'poll', source: 'board', items: [listed('Review')] }).state;
  const reviewed = withWork(polledIn, ID, { slug: 'hive-1-task-1', worktree: '/tmp/worktrees/hive-1-task-1' });
  const opened = reduce(reviewed, { type: 'openSession', activityId: live(reviewed)?.id ?? 'none' }).state;
  const runId = opened.workers.find((w) => w.freeSession)?.runId ?? 'none';
  const held = reduce(opened, { type: 'poll', source: 'board', items: [listed('CI')] });
  assert.deepEqual([held.state.tasks[0].stage, live(held.state)?.ci, effectOf(held.effects, 'ciRead')], ['ci', undefined, undefined], 'the session holds the wait');
  const ends: HiveEvent[] = [
    { type: 'exit', ptyId: runId },
    { type: 'hook', ptyId: runId, payload: { hook_event_name: 'SessionEnd', reason: 'other' } },
    { type: 'spawnFailed', ptyId: runId, message: 'no pty' },
  ];
  for (const event of ends) {
    const ended = reduce(held.state, event);
    assert.ok(live(ended.state)?.ci, `${event.type} starts the wait`);
    assert.deepEqual(effectOf(ended.effects, 'ciRead'), { type: 'ciRead', activityId: live(ended.state)?.id });
  }
  const cleared = reduce(held.state, { type: 'hook', ptyId: runId, payload: { hook_event_name: 'SessionEnd', reason: 'clear' } });
  assert.equal(effectOf(cleared.effects, 'ciRead'), undefined, 'a /clear ends the conversation, not the session');
  const quitting = reduce({ ...held.state, cleanStop: true }, { type: 'exit', ptyId: runId });
  assert.equal(effectOf(quitting.effects, 'ciRead'), undefined, 'a Quit\'s kills act on nothing');
});
