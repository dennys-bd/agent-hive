import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, resultOf, withActivity } from '../src/activities.js';
import { deriveEvents } from '../src/event-derive.js';
import { describeEffect, describeEvent } from '../src/log.js';
import { initialState, reduce, type Reduced } from '../src/orchestrator.js';
import { savedWork } from '../src/state-guards.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, Effect, HiveEvent, Item, SourceItem, Stage, State, Transition } from '../src/types.js';
import { chained } from './fakes.js';

// A commands stage (#755): the reducer's side, end to end through reduce. The task is polled into the stage under green: the fill starts the
// stage in the one worker, and every effect below is the stage's own.

const ID = 'board:item1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const listed = (column: string, extra: Partial<Item> = {}): SourceItem => ({ item: { ...item, ...extra }, column });
const checks = (extra: Partial<Stage> = {}): LegacyStage => ({ name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build', 'lint', 'test'], stopOnFailure: true, ...extra });
const REVIEW: LegacyStage = { name: 'review', from: { board: ['Review'] } };
const base = (extra: Partial<Stage> = {}, state: Partial<State> = {}): State =>
  ({ ...initialState(1), signal: 'green', workspaces: ['hive'], syncs: { board: {} }, ...chained([checks(extra), REVIEW]), ...state });
const polled = (extra: Partial<Stage> = {}, state: Partial<State> = {}): Reduced => reduce(base(extra, state), { type: 'poll', source: 'board', items: [listed('Checks')] });
const live = (s: State): Activity | undefined => activityOf(s, ID);
const commandOf = (effects: Effect[]): Extract<Effect, { type: 'stageCommand' }> | undefined =>
  effects.find((e): e is Extract<Effect, { type: 'stageCommand' }> => e.type === 'stageCommand');
const endOf = (s: State, code: number, output = ''): Extract<HiveEvent, { type: 'stageCommandEnded' }> =>
  ({ type: 'stageCommandEnded', activityId: live(s)?.id ?? 'none', ptyId: live(s)?.commands?.ptyId ?? 'none', code, output });
const ended = (s: State, code: number, output = ''): Reduced => reduce(s, endOf(s, code, output));
// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

test('a due task in a commands stage starts its first command: the run on its activity, one stageCommand effect; the run holds the one worker; it is not due again (#755, #727)', () => {
  const { state, effects } = polled();
  const run = live(state)?.commands;
  assert.ok(run, 'the run is on the activity');
  assert.deepEqual([run.stage, run.at, run.failed], ['checks', 0, []]);
  const effect = commandOf(effects);
  assert.ok(effect);
  assert.deepEqual([effect.at, effect.ptyId, effect.stage.name, effect.task.item.itemId, effect.activity.commands], [0, run.ptyId, 'checks', ID, run]);
  assert.equal(effects.filter((e) => e.type === 'stageCommand').length, 1);
  assert.deepEqual(state.workers.map((w) => [w.status, w.runId, w.activityId, w.id === run.workerId]), [['working', undefined, undefined, true]], 'a command is no session: no run id, no activity, yet the worker is the run\'s');
  assert.equal(state.tasks[0].workspace, 'hive', 'the workspace is frozen as a spawn freezes it');
  assert.equal(commandOf(reduce(state, { type: 'poll', source: 'board', items: [listed('Checks')] }).effects), undefined, 'a task whose activity holds commands is not due again');
});

test('code 0 runs the next command in a fresh pty; the last 0 merges passed into the record and moves the task on (#755)', () => {
  const first = polled().state;
  const firstPty = live(first)?.commands?.ptyId;
  const runId = live(first)?.commands?.runId;
  assert.equal(runId, firstPty, 'the execution is named by its first pty');
  const second = ended(first, 0);
  const next = commandOf(second.effects);
  assert.ok(next);
  assert.deepEqual([next.at, next.ptyId === firstPty, live(second.state)?.commands?.ptyId === next.ptyId], [1, false, true]);
  const third = ended(second.state, 0).state;
  const done = ended(third, 0).state;
  assert.deepEqual([done.tasks[0].stage, live(done)?.commands], ['review', undefined]);
  assert.deepEqual(live(second.state)?.commands?.runId, runId, 'every next command keeps it');
  assert.deepEqual(resultOf(done, ID)?.commands, { verdict: 'passed', runId });
});

test('a failure with stopOnFailure ends the stage failed: the task stops in it with the failure named and the record holds the output (#755)', () => {
  const start = polled().state;
  const runId = live(start)?.commands?.runId;
  const { state, effects } = ended(start, 1, 'boom');
  assert.equal(commandOf(effects), undefined, 'nothing more runs');
  const activity = live(state);
  assert.deepEqual([state.tasks[0].stage, activity?.commands, activity?.stopped, activity?.error], ['checks', undefined, true, 'checks failed: build (1)']);
  assert.ok(activity?.stoppedAt);
  assert.deepEqual(resultOf(state, ID)?.commands, { verdict: 'failed', output: 'build (1)\nboom', runId });
  assert.deepEqual(reduce(state, { type: 'poll', source: 'board', items: [listed('Checks')] }).effects, [], 'out of the automation until a manual start');
});

test('without stopOnFailure every command runs and the failures are joined (#755)', () => {
  const begun = polled({ stopOnFailure: false }).state;
  const runId = live(begun)?.commands?.runId;
  const a = ended(begun, 1, 'b1').state;
  assert.equal(live(a)?.commands?.at, 1);
  const b = ended(a, 0).state;
  const c = ended(b, 2, 't2').state;
  assert.equal(live(c)?.error, 'checks failed: build (1), test (2)');
  assert.deepEqual(resultOf(c, ID)?.commands, { verdict: 'failed', output: 'build (1)\nb1\n\ntest (2)\nt2', runId });
});

test('stageCommandsRefused ends the stage failed with the message, nothing more running (#755)', () => {
  const s = polled().state;
  const runId = live(s)?.commands?.runId;
  const message = 'lint: not in hive\ne2e: not in hive';
  const { state, effects } = reduce(s, { type: 'stageCommandsRefused', activityId: live(s)?.id ?? '', ptyId: live(s)?.commands?.ptyId ?? '', message });
  assert.deepEqual(effects, []);
  assert.deepEqual([live(state)?.commands, live(state)?.stopped, live(state)?.error], [undefined, true, 'checks failed: lint: not in hive, e2e: not in hive']);
  assert.deepEqual(resultOf(state, ID)?.commands, { verdict: 'failed', output: message, runId });
});

test('an answer for another pty, or either answer during a Quit, changes nothing (#755)', () => {
  const s = polled().state;
  assert.deepEqual(reduce(s, { ...endOf(s, 0), ptyId: 'other' }).state, s);
  assert.deepEqual(reduce(s, { type: 'stageCommandsRefused', activityId: live(s)?.id ?? '', ptyId: 'other', message: 'x' }).state, s);
  const quitting = reduce(s, { type: 'quit' }).state;
  assert.deepEqual(reduce(quitting, endOf(quitting, 1)).state, quitting, 'a Quit\'s kills never end the stage');
  assert.deepEqual(reduce(quitting, { type: 'stageCommandsRefused', activityId: live(s)?.id ?? '', ptyId: live(s)?.commands?.ptyId ?? '', message: 'x' }).state, quitting);
});

test('a manual start runs a failed commands stage again, its error cleared, and ignores one already running (#755)', () => {
  const failed = ended(polled().state, 1).state;
  const { state, effects } = reduce(failed, { type: 'start', itemId: ID });
  assert.deepEqual([live(state)?.error, live(state)?.stopped, live(state)?.commands?.at], [undefined, undefined, 0]);
  assert.ok(commandOf(effects));
  assert.deepEqual(reduce(state, { type: 'start', itemId: ID }).effects, [], 'already running');
  const blocked = reduce(base(), { type: 'poll', source: 'board', items: [listed('Checks', { blockedBy: ['9'] })] }).state;
  assert.equal(live(blocked)?.commands, undefined, 'a commands stage takes a worker, so blockers hold it as they hold a prompt stage (#727)');
  assert.ok(commandOf(reduce(blocked, { type: 'start', itemId: ID }).effects), 'a start by hand still runs past them');
});

test('a task with auto off, or whose after has not passed, is not due (#755)', () => {
  const off = reduce(base(), { type: 'poll', source: 'board', items: [listed('Checks', { autoOnEntry: false })] });
  assert.equal(commandOf(off.effects), undefined);
  assert.equal(commandOf(polled({ after: '5d' }).effects), undefined);
  assert.equal(commandOf(polled({}, { workspaces: ['hive', 'site'] }).effects), undefined, 'no workspace resolved: nothing to run in');
});

test('a task running its commands cannot be moved by hand or by its source column (#755)', () => {
  const s = polled().state;
  assert.equal(reduce(s, { type: 'moveToStage', taskId: ID, stage: 'review' }).state.tasks[0].stage, 'checks');
  assert.equal(reduce(s, { type: 'poll', source: 'board', items: [listed('Review')] }).state.tasks[0].stage, 'checks');
});

test('the reducer never mutates the state it is given (#755)', () => {
  const frozen = deepFreeze(polled().state);
  ended(frozen, 0);
  ended(frozen, 1, 'x');
  reduce(frozen, { type: 'stageCommandsRefused', activityId: live(frozen)?.id ?? '', ptyId: live(frozen)?.commands?.ptyId ?? '', message: 'x' });
  const failed = deepFreeze(ended(polled().state, 1).state);
  reduce(failed, { type: 'start', itemId: ID });
});

test('the log names a command\'s end by its pty and code, never its output, and a refusal by its first line; a passed stage\'s move is on_finish (#755)', () => {
  const s = polled().state;
  const line = describeEvent(endOf(s, 2, 'secret output'));
  assert.match(line, /^stageCommandEnded activity=\S+ pty=\S+ code=2$/);
  assert.equal(describeEvent({ type: 'stageCommandsRefused', activityId: 'a', ptyId: 'p', message: 'lint: not in hive\nmore' }).includes('more'), false);
  const effect = commandOf(polled().effects);
  assert.ok(effect);
  assert.match(describeEffect(effect), /^stageCommand #1 stage="checks" command="build" 1\/3 pty=\S+$/);
  const last = ended(ended(s, 0).state, 0).state;
  const event = endOf(last, 0);
  assert.match(JSON.stringify(deriveEvents(last, reduce(last, event).state, event, Date.now())), /"event":"task.moved"[^}]*"by":"on_finish"/);
});

test('a Stop on the stage pty kills it under the task\'s slug and stops the activity with no verdict; the pty\'s late end changes nothing (#755)', () => {
  const s = polled().state;
  const ptyId = live(s)?.commands?.ptyId ?? '';
  const { state, effects } = reduce(s, { type: 'stop', ptyId, cause: 'manual' });
  assert.deepEqual(effects, [{ type: 'kill', slug: live(s)?.slug, ptyId }]);
  assert.deepEqual([live(state)?.commands, live(state)?.stopped, live(state)?.error, state.tasks[0].stage], [undefined, true, undefined, 'checks']);
  assert.equal(resultOf(state, ID), undefined, 'a stop is no verdict');
  assert.equal(state.workers[0].status, 'empty', 'the run\'s worker frees with it');
  const late = reduce(state, { type: 'stageCommandEnded', activityId: live(state)?.id ?? '', ptyId, code: 0, output: '' }).state;
  assert.deepEqual([late.tasks, live(late)], [state.tasks, live(state)], 'a killed pty exits 0: it must never read as passed');
});

test('deleting the activity stops its commands stage as it closes its terminals (#755)', () => {
  const s0 = polled().state;
  const s = withActivity(s0, { ...(live(s0) as Activity), worktree: '/wt/hive-1-task-1' });
  const ptyId = live(s)?.commands?.ptyId;
  const { state, effects } = reduce(s, { type: 'deletingActivity', activityId: live(s)?.id ?? '' });
  assert.ok(effects.some((e) => e.type === 'kill' && e.ptyId === ptyId));
  assert.deepEqual([live(state)?.deleting, live(state)?.commands, live(state)?.stopped], [true, undefined, true]);
});

test('closing a missing task kills its commands stage with it (#755)', () => {
  const s = polled().state;
  const missing = reduce(s, { type: 'poll', source: 'board', items: [] }).state;
  assert.equal(missing.tasks[0].missing, true);
  const { effects } = reduce(missing, { type: 'closeTask', taskId: ID });
  assert.ok(effects.some((e) => e.type === 'kill' && e.ptyId === live(s)?.commands?.ptyId));
});

test('the boot drops a commands stage in flight and leaves its activity stopped, after a crash and after a Quit (#755)', () => {
  const s = polled().state;
  for (const before of [s, reduce(s, { type: 'quit' }).state]) {
    const booted = reduce(before, { type: 'boot' }).state;
    assert.deepEqual([live(booted)?.commands, live(booted)?.stopped, resultOf(booted, ID)], [undefined, true, undefined]);
    assert.equal(booted.workers.every((w) => w.status === 'empty'), true, 'and its worker frees');
  }
});

test('a saved activity keeps its commands run so the boot can see it; a malformed one reads as none, a malformed failure is dropped (#755)', () => {
  const run = { stage: 'checks', at: 1, ptyId: 'p1', runId: 'r1', failed: [{ name: 'build', code: 1, output: 'boom' }], workerId: 'w1', started: ['2026-10-10T10:00:00.000Z', ''] };
  assert.deepEqual(savedWork({ commands: run }).commands, run);
  for (const bad of [{ ...run, at: 'one' }, { ...run, ptyId: 1 }, { ...run, runId: undefined }, { ...run, failed: 'x' }, { ...run, workerId: 1 }, 'x']) assert.equal(savedWork({ commands: bad }).commands, undefined, JSON.stringify(bad));
  assert.deepEqual(savedWork({ commands: { ...run, failed: [{ name: 'build' }] } }).commands?.failed, []);
  assert.deepEqual(savedWork({ commands: { ...run, started: 'x' } }).commands?.started, [], '#914: a malformed start list reads as none');
});

test('a stop, a delete and a boot never mutate the state they are given (#755)', () => {
  const frozen = deepFreeze(polled().state);
  reduce(frozen, { type: 'stop', ptyId: live(frozen)?.commands?.ptyId ?? '' });
  reduce(frozen, { type: 'boot' });
  reduce(frozen, { type: 'closeTask', taskId: ID });
});

test('a failure with a failed transition takes it: the output on the record, the task on its way with its try counted; out of tries it stops; without one it stops as before (#134)', () => {
  const retry: Transition = { from: 'checks', to: 'checks', when: 'verdict', verdict: 'failed', maxTries: 1 };
  const flow = { transitions: [...chained([checks(), REVIEW]).transitions, retry] };
  const first = polled({}, flow).state;
  const runId = live(first)?.commands?.runId;
  const retried = ended(first, 1, 'boom');
  assert.ok(commandOf(retried.effects), 'the loop to its own stage runs the stage again at once');
  assert.equal(retried.state.workers[0].status, 'working', 'the freed worker takes the retry');
  assert.deepEqual([live(retried.state)?.stopped, live(retried.state)?.tries], [undefined, { '["checks","verdict","failed"]': 1 }]);
  assert.deepEqual(resultOf(retried.state, ID)?.commands, { verdict: 'failed', output: 'build (1)\nboom', runId });
  const out = ended(retried.state, 1, 'again').state;
  assert.deepEqual([live(out)?.stopped, live(out)?.error], [true, 'tries out: verdict:failed · 1']);
  assert.equal((resultOf(out, ID)?.commands as { output?: string } | undefined)?.output, 'build (1)\nagain');
});

const T0 = '2026-10-10T10:00:00.000Z';
const T1 = '2026-10-10T10:02:05.000Z';
const startedOf = (s: State, at: string, skipped?: true): Extract<HiveEvent, { type: 'stageCommandStarted' }> =>
  ({ type: 'stageCommandStarted', activityId: live(s)?.id ?? 'none', ptyId: live(s)?.commands?.ptyId ?? 'none', at, ...(skipped ? { skipped } : {}) });
const outputOf = (s: State, at: string): Extract<HiveEvent, { type: 'stageCommandOutput' }> =>
  ({ type: 'stageCommandOutput', activityId: live(s)?.id ?? 'none', ptyId: live(s)?.commands?.ptyId ?? 'none', at });

test('stageCommandStarted records the current command\'s start by its index, a skipped one marked; another pty changes nothing (#914)', () => {
  const s = polled().state;
  assert.deepEqual(live(s)?.commands?.started, []);
  const one = reduce(s, startedOf(s, T0)).state;
  assert.deepEqual(live(one)?.commands?.started, [T0]);
  const second = ended(one, 0).state;
  const two = reduce(second, startedOf(second, T1, true)).state;
  assert.deepEqual([live(two)?.commands?.started, live(two)?.commands?.skipped], [[T0, T1], [1]]);
  const other = reduce(two, { ...startedOf(two, T0), ptyId: 'other' });
  assert.equal(live(other.state), live(two));
  assert.deepEqual(other.effects, []);
});

test('a start that never came reads as \'\' before the next one (#914)', () => {
  const second = ended(polled().state, 0).state; // command 0 ended without a start: its pty never started
  assert.deepEqual(live(reduce(second, startedOf(second, T1)).state)?.commands?.started, ['', T1]);
});

test('stageCommandOutput sets the current command\'s last output; another pty changes nothing; the next command drops it; the input is never mutated (#914)', () => {
  const s = deepFreeze(polled().state);
  const wrote = reduce(s, outputOf(s, T1)).state;
  assert.equal(live(wrote)?.commands?.outputAt, T1);
  assert.equal(live(reduce(s, { ...outputOf(s, T1), ptyId: 'other' }).state), live(s));
  assert.equal(live(ended(wrote, 0).state)?.commands?.outputAt, undefined);
  reduce(s, startedOf(s, T0)); // a write to the frozen input would throw here
});

test('the two events log their activity and pty, never an output (#914)', () => {
  assert.equal(describeEvent({ type: 'stageCommandStarted', activityId: 'a', ptyId: 'p', at: T0, skipped: true }).endsWith(' skipped'), true);
  assert.equal(describeEvent({ type: 'stageCommandOutput', activityId: 'a', ptyId: 'p', at: T0 }).startsWith('stageCommandOutput '), true);
});
