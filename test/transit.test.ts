import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { advance, type EndOf, take, unrouted } from '../src/transit.js';
import { transitionKey } from '../src/transitions.js';
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
