import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/activities.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { advance, dismissError, type EndOf, follow, retry, take, unrouted } from '../src/transit.js';
import { transitionKey } from '../src/transitions.js';
import { FEEDBACK_MAX } from '../src/types.js';
import type { Activity, Item, Stage, State, Task, Transition, TryRecord } from '../src/types.js';
import { withWork } from './fixtures/work.js';

// The try history (#915): take records each try an automatic transition with maxTries counts, and wherever the tries go the log goes.
// Called directly on a hand-built state; every input is frozen deep and compared after the call.

const ID = 'board:1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const STAGES: Stage[] = [
  { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build', 'test'] },
  { name: 'fix', from: { board: ['Fix'] }, prompt: '/fix {url}' },
];
const RETRY: Transition = { from: 'checks', to: 'fix', when: 'verdict', verdict: 'failed', maxTries: 3 };
const KEY = transitionKey(RETRY);
const FAILED: EndOf = { trigger: 'verdict', verdict: 'failed', cause: 'build (1), test (2)' };
const OUTPUT = '\n  \nbuild (1)\nboom\n\ntest (2)\nred';
const AT = '2026-10-10T10:00:00.000Z';
const recordOf = (transition: string, n: number): TryRecord => ({ transition, n, max: 3, cause: 'build (1)', error: 'boom', at: AT, stage: 'fix' });

// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

interface Placement { stage?: string; stages?: Stage[]; transitions?: Transition[]; result?: Record<string, unknown> }

// The task in `stage`, its activity holding `work`, its record holding `result`; frozen
function placed(work: Partial<Activity> = {}, { stage = 'checks', stages = STAGES, transitions = [RETRY], result = { commands: { verdict: 'failed', output: OUTPUT } } }: Placement = {}): State {
  const task: Task = { item, stage, boardColumn: '', auto: true, workspace: 'hive' };
  return deepFreeze(withWork({ ...initialState(0), workspaces: ['hive'], stages, transitions, tasks: [task] }, ID, work, { result }));
}

// The call, which must leave its input as it was
function pure<T>(state: State, call: (s: State) => T): T {
  const before = structuredClone(state);
  const out = call(state);
  assert.deepEqual(state, before, 'the input state is not mutated');
  return out;
}

const log = (s: State): TryRecord[] | undefined => activityOf(s, ID)?.tryLog;

test('an automatic try through a transition with maxTries appends its record: the try, the limit, the failed names, the first non-blank line, the destination (#915)', () => {
  const next = pure(placed(), (s) => advance(s, s.tasks[0], FAILED)).state;
  const [{ at, ...record }] = log(next) ?? [];
  assert.deepEqual(record, { transition: KEY, n: 1, max: 3, cause: 'build (1), test (2)', error: 'build (1)', stage: 'fix' });
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.deepEqual([next.tasks[0].stage, activityOf(next, ID)?.tries], ['fix', { [KEY]: 1 }]);
});

test('a second try appends n 2 beside the first; the exhausting end appends nothing and stops the task with TRIES_OUT (#915)', () => {
  const second = pure(placed({ tries: { [KEY]: 1 }, tryLog: [recordOf(KEY, 1)] }), (s) => advance(s, s.tasks[0], FAILED)).state;
  assert.deepEqual(log(second)?.map((r) => r.n), [1, 2]);
  const spent = [1, 2, 3].map((n) => recordOf(KEY, n));
  const out = pure(placed({ tries: { [KEY]: 3 }, tryLog: spent }), (s) => advance(s, s.tasks[0], FAILED)).state;
  assert.deepEqual([out.tasks[0].stage, activityOf(out, ID)?.error, log(out)], ['checks', 'tries out: verdict:failed · 3', spent]);
});

test('an agent\'s try names its exit, the evidence\'s first line and the session the handover resumes (#915)', () => {
  const session = '11111111-1111-4111-8111-111111111111';
  const stages: Stage[] = [
    { name: 'review', from: { board: ['Review'] }, prompt: '/review {url}', verdicts: ['redo'] },
    { name: 'build', from: { board: ['Ready'] }, prompt: '/build {url}' },
  ];
  const redo: Transition = { from: 'review', to: 'build', when: 'verdict', verdict: 'redo', maxTries: 2, session: 'previous' };
  const state = placed({ sessionId: session }, { stage: 'review', stages, transitions: [redo], result: { verdict: { name: 'redo', evidence: 'src/a.ts:3 fails\nsecond' } } });
  const next = pure(state, (s) => advance(s, s.tasks[0], { trigger: 'verdict', verdict: 'redo' })).state;
  const [{ at: _at, ...record }] = log(next) ?? [];
  assert.deepEqual(record, { transition: transitionKey(redo), n: 1, max: 2, cause: 'verdict:redo', error: 'src/a.ts:3 fails', stage: 'build', sessionId: session });
});

test('a user\'s transition and a move by hand drop the log with the tries; an automatic one without maxTries keeps the records it still counts (#915)', () => {
  const work: Partial<Activity> = { tries: { [KEY]: 1 }, tryLog: [recordOf(KEY, 1)], via: KEY };
  const approved: Transition = { from: 'checks', to: 'fix', when: 'approved' };
  const byUser = pure(placed(work), (s) => take(s, s.tasks[0], approved, { trigger: 'approved' })).state;
  assert.deepEqual([activityOf(byUser, ID)?.tries, log(byUser)], [undefined, undefined]);
  const byHand = pure(placed(work), (s) => unrouted(s, ID));
  assert.deepEqual([activityOf(byHand, ID)?.tries, activityOf(byHand, ID)?.via, log(byHand)], [undefined, undefined, undefined]);
  const passed: Transition = { from: 'checks', to: 'fix', when: 'verdict', verdict: 'passed' };
  const onward = pure(placed(work), (s) => take(s, s.tasks[0], passed, { trigger: 'verdict', verdict: 'passed' })).state;
  assert.deepEqual(log(onward), [recordOf(KEY, 1)]);
});

const OTHER: Transition = { from: 'fix', to: 'checks', when: 'done', maxTries: 2 };
const HALTED: Partial<Activity> = { stopped: true, stoppedAt: AT, error: 'tries out: verdict:failed · 3' };

test('retry takes the spent transition again: its counter and records gone, the other transition\'s kept, the stop and error cleared, the task in the destination with its handover (#915)', () => {
  const prompted: Transition = { ...RETRY, prompt: 'Fix: {verdict}' };
  const other = recordOf(transitionKey(OTHER), 1);
  const work: Partial<Activity> = { ...HALTED, tries: { [KEY]: 3, [transitionKey(OTHER)]: 1 }, tryLog: [...[1, 2, 3].map((n) => recordOf(KEY, n)), other] };
  const state = placed(work, { transitions: [prompted, OTHER], result: { commands: { verdict: 'failed', output: 'build (1)\nboom' } } });
  const retried = pure(state, (s) => retry(s, ID));
  assert.ok(retried);
  const live = activityOf(retried.state, ID);
  assert.deepEqual([retried.state.tasks[0].stage, live?.stopped, live?.stoppedAt, live?.error], ['fix', undefined, undefined, undefined]);
  assert.deepEqual([live?.tries, live?.tryLog, live?.via], [{ [transitionKey(OTHER)]: 1 }, [other], KEY], 'a retry counts no try and records none');
  assert.match(live?.handover?.prompt ?? '', /^\/fix [^\n]*\n\nFix: build \(1\)\nboom/); // #710: the stage's command first
});

test('retry answers undefined when the error is no TRIES_OUT, the transition is gone or renamed, a run holds the task, or the task is unknown (#915)', () => {
  const tries = { [KEY]: 3 };
  assert.equal(retry(placed({ ...HALTED, error: 'no transition: verdict:failed', tries }), ID), undefined);
  assert.equal(retry(placed({ ...HALTED, tries }, { transitions: [] }), ID), undefined);
  assert.equal(retry(placed({ ...HALTED, tries }, { transitions: [{ ...RETRY, verdict: 'passed' }] }), ID), undefined);
  assert.equal(retry(placed({ ...HALTED, tries, workerId: 'w1' }), ID), undefined);
  assert.equal(retry(placed({ ...HALTED, tries }), 'board:nope'), undefined);
});

test('a retry event into a prompt stage starts the destination\'s run at once: the fill picks the task once its stop is cleared (#915)', () => {
  const task: Task = { item, stage: 'checks', boardColumn: '', auto: true, workspace: 'hive' };
  const halted = deepFreeze(withWork({ ...initialState(1), signal: 'green', workspaces: ['hive'], stages: STAGES, transitions: [RETRY], tasks: [task] }, ID,
    { ...HALTED, tries: { [KEY]: 3 } }, { result: { commands: { verdict: 'failed', output: OUTPUT } } }));
  const { state, effects } = pure(halted, (s) => reduce(s, { type: 'retry', taskId: ID }));
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.deepEqual([state.tasks[0].stage, spawn?.type === 'spawn' ? spawn.stage.name : undefined], ['fix', 'fix']);
});

test('a try\'s cause and error lose their control characters and stay within FEEDBACK_MAX (#915)', () => {
  const raw = `\u001b[31m${'x'.repeat(FEEDBACK_MAX + 10)}`;
  const state = placed({}, { result: { commands: { verdict: 'failed', output: raw } } });
  const [record] = log(advance(state, state.tasks[0], { ...FAILED, cause: '\u001b[1mbuild (1)' }).state) ?? [];
  assert.equal(record?.cause, '[1mbuild (1)');
  assert.ok(record !== undefined && record.error.length === FEEDBACK_MAX && !record.error.includes('\u001b'));
});

test('follow goes through a transition as an epic does: its sources written and its arrow kept, no try counted or recorded, no handover; a leaving action holds the task (#213)', () => {
  const FEEDBACK: Transition = { from: 'checks', to: 'fix', when: 'feedback', sources: { board: [{ type: 'move', column: 'Fix' }] } };
  const fed = pure(placed({ tries: { [KEY]: 1 }, tryLog: [recordOf(KEY, 1)] }, { transitions: [FEEDBACK] }), (s) => follow(s, s.tasks[0], FEEDBACK));
  assert.deepEqual(fed.effects, [{ type: 'setColumn', itemId: ID, column: 'Fix' }]);
  const live = activityOf(fed.state, ID);
  assert.deepEqual([fed.state.tasks[0].stage, live?.via, live?.tries, live?.tryLog], ['fix', transitionKey(FEEDBACK), undefined, undefined], 'the arrow, and the old tries gone');
  assert.deepEqual([live?.handover, fed.handover], [undefined, undefined], 'a feedback into a stage with a prompt hands nothing over: no run reads it');
  const counted = activityOf(pure(placed(), (s) => follow(s, s.tasks[0], RETRY)).state, ID);
  assert.deepEqual([counted?.tries, counted?.tryLog], [undefined, undefined], 'maxTries counts nothing');
  const ARCHIVE: Transition = { ...RETRY, sources: { board: [{ type: 'archive' }] } };
  const held = pure(placed(), (s) => follow(s, s.tasks[0], ARCHIVE));
  assert.deepEqual([held.state.tasks[0].stage, held.state.tasks[0].leaving], ['checks', true], 'held until the source answers');
  assert.deepEqual(held.effects, [{ type: 'sourceAction', itemId: ID, taskId: ID, action: { type: 'archive' } }]);
});

// #354: a wait-for-CI stage beside the file's commands and prompt stages, and a task stopped with an error a dismiss clears
const CI: Stage = { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: false };
const ERRED: Partial<Activity> = { stopped: true, stoppedAt: AT, error: 'no transition: done' };
const SPENT: Partial<Activity> = { tries: { [KEY]: 3 }, tryLog: [recordOf(KEY, 1)] };

test('dismissError in a stage with an action drops the error and the stop; in a prompt stage it drops the error and keeps the stop; the stage, tries and tryLog stay, no effect (#354)', () => {
  const inCi = pure(placed({ ...ERRED, ...SPENT }, { stage: 'ci', stages: [...STAGES, CI] }), (s) => dismissError(s, ID));
  assert.ok(inCi);
  const ci = activityOf(inCi.state, ID);
  assert.deepEqual([inCi.state.tasks[0].stage, ci?.error, ci?.stopped, ci?.stoppedAt, inCi.effects], ['ci', undefined, undefined, undefined, []]);
  assert.deepEqual([ci?.tries, ci?.tryLog], [SPENT.tries, SPENT.tryLog], 'a dismiss resets no counter: that is retry\'s');
  const inFix = pure(placed({ ...ERRED, ...SPENT }, { stage: 'fix' }), (s) => dismissError(s, ID));
  assert.ok(inFix);
  const fix = activityOf(inFix.state, ID);
  assert.deepEqual([inFix.state.tasks[0].stage, fix?.error, fix?.stopped, fix?.stoppedAt], ['fix', undefined, true, AT], 'a prompt stage stays stopped: no session until someone starts it');
  assert.deepEqual([fix?.tries, fix?.tryLog], [SPENT.tries, SPENT.tryLog]);
  const unheld = pure(placed({ error: 'no transition: done' }, { stage: 'fix' }), (s) => dismissError(s, ID));
  assert.equal(activityOf(unheld?.state ?? placed({}), ID)?.stopped, true, 'an error that came without a stop still leaves a prompt stage stopped');
});

test('dismissError answers undefined for an unknown task, a missing one, one with no error and one a run holds (#354)', () => {
  assert.equal(dismissError(placed(ERRED), 'board:nope'), undefined);
  assert.equal(dismissError(placed({ stopped: true }), ID), undefined);
  assert.equal(dismissError(placed({ ...ERRED, workerId: 'w1' }), ID), undefined);
  const erred = placed(ERRED);
  assert.equal(dismissError(deepFreeze({ ...erred, tasks: [{ ...erred.tasks[0], missing: true }] }), ID), undefined);
});

// The task stopped with an error in `stage`, one free worker and green: what the due actions and the fill read
function erredIn(stage: string): State {
  const task: Task = { item, stage, boardColumn: '', auto: true, workspace: 'hive' };
  return deepFreeze(withWork({ ...initialState(1), signal: 'green', workspaces: ['hive'], stages: [...STAGES, CI], transitions: [RETRY], tasks: [task] }, ID, ERRED));
}

test('a dismissError event in a wait-for-CI stage starts the wait on the same dispatch; in a prompt stage with auto on it spawns nothing (#354)', () => {
  const ci = pure(erredIn('ci'), (s) => reduce(s, { type: 'dismissError', taskId: ID }));
  assert.deepEqual([activityOf(ci.state, ID)?.ci?.stage, ci.effects.some((e) => e.type === 'ciRead')], ['ci', true]);
  const fix = pure(erredIn('fix'), (s) => reduce(s, { type: 'dismissError', taskId: ID }));
  const live = activityOf(fix.state, ID);
  assert.deepEqual([live?.error, live?.stopped, fix.effects.filter((e) => e.type === 'spawn')], [undefined, true, []]);
});
