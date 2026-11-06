import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, resultOf, withActivity } from '../src/activities.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { transitionKey } from '../src/transitions.js';
import type { Effect, HiveEvent, Item, Stage, State, TaskApproval, Transition } from '../src/types.js';
import { move } from './fakes.js';
import { workId } from './fixtures/work.js';
import { flowed } from './fixtures/main-flow.js';

// #693: an approval stage that ends with a verdict waits for the user, routed or not; approving fires the verdict's own transition, else
// approved. End to end through reduce.

const ID = 'board:1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const STAGES: Stage[] = [
  { name: 'Brainstorm', from: { board: ['Ready'] }, prompt: '/brainstorm {url}', approval: true, verdicts: ['spike', 'task'] },
  { name: 'Spike', from: { board: ['Spike'] }, prompt: '/spike {url}' },
  { name: 'Spec', from: { board: ['Spec'] }, prompt: '/spec {url}' },
];
// Spike goes on in the session: a stage end whose approval leads there holds its Stop
const CONTINUING: Stage[] = STAGES.map((s) => (s.name === 'Spike' ? { ...s, session: 'continue' as const } : s));
const SPIKE: Transition = { from: 'Brainstorm', to: 'Spike', when: 'verdict', verdict: 'spike', prompt: 'Spike this:\n\n{verdict}', sources: { board: [move('Spiking')] } };
const APPROVED: Transition = { from: 'Brainstorm', to: 'Spec', when: 'approved' };
const FEEDBACK: Transition = { from: 'Brainstorm', to: 'Brainstorm', when: 'feedback' };
const TRANSITIONS: Transition[] = [SPIKE, APPROVED, FEEDBACK];

// Task 1 polled into Brainstorm, running in the only worker, green
const flow = (transitions: Transition[] = TRANSITIONS, stages: Stage[] = STAGES): State =>
  reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...flowed(stages, transitions) }, { type: 'poll', source: 'board', items: [{ item, column: 'Ready' }] }).state;
// hive_done, then its Stop: what ends a stage
const stageEnd = (state: State, done: Partial<Extract<HiveEvent, { type: 'done' }>> = {}) => {
  const ptyId = state.workers[0].runId ?? '';
  return reduce(reduce(state, { type: 'done', ptyId, ...done }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
};
const approve = (state: State) => reduce(state, { type: 'approve', activityId: workId(state, ID) });
const red = (state: State): State => reduce(state, { type: 'setSignal', signal: 'red' }).state;
const taskOf = (s: State) => s.tasks.find((t) => t.item.itemId === ID);
const columns = (effects: Effect[]): string[] => effects.flatMap((e) => (e.type === 'setColumn' ? [e.column] : []));
const withApproval = (state: State, approval: TaskApproval): State => withActivity(state, { ...activityOf(state, ID)!, approval });
const past = (): string => new Date(Date.now() - 1).toISOString();

test('an approval stage whose stage run ends with a routed verdict awaits approval with the verdict stored, and no transition is taken (#693)', () => {
  const { state, effects } = stageEnd(flow(), { verdict: 'spike', evidence: 'src/daemon.ts:88' });
  assert.deepEqual([taskOf(state)?.stage, activityOf(state, ID)?.approval?.verdict, activityOf(state, ID)?.via, columns(effects)], ['Brainstorm', 'spike', undefined, []]);
  assert.deepEqual(resultOf(state, ID)?.verdict, { name: 'spike', evidence: 'src/daemon.ts:88' }, 'the evidence stays on the record, once');
  assert.ok(effects.some((e) => e.type === 'kill'), 'Spike starts a new session: nothing to hold');
});

test('approving it takes the verdict\'s transition, not approved: its sources, its destination and its prompt with {verdict} filled (#693)', () => {
  const parked = red(stageEnd(flow(), { verdict: 'spike', evidence: 'src/daemon.ts:88' }).state); // under red the handover stays queued
  const { state, effects } = approve(parked);
  const live = activityOf(state, ID);
  assert.deepEqual([taskOf(state)?.stage, columns(effects), live?.approval, live?.via], ['Spike', ['Spiking'], undefined, transitionKey(SPIKE)]);
  assert.deepEqual(live?.handover, { prompt: '/spike https://github.com/o/r/issues/1\n\nSpike this:\n\nsrc/daemon.ts:88' });
});

test('a held verdict approval whose transition keeps the run\'s session holds the worker, and approving goes on in place into the verdict\'s destination (#693)', () => {
  const first = flow(TRANSITIONS, CONTINUING);
  const ptyId = first.workers[0].runId!;
  const held = stageEnd(first, { verdict: 'spike' });
  assert.deepEqual([held.state.workers[0].status, held.effects.some((e) => e.type === 'hold')], ['approval', true]);
  const { state, effects } = approve(held.state);
  const go = effects.find((e): e is Extract<Effect, { type: 'continue' }> => e.type === 'continue');
  assert.deepEqual([go?.stage.name, go?.ptyId, taskOf(state)?.stage, state.workers[0].runId], ['Spike', ptyId, 'Spike', ptyId]);
});

test('feedback on a routed verdict approval takes the feedback transition, as today (#693)', () => {
  const parked = red(stageEnd(flow(), { verdict: 'spike' }).state);
  const { state } = reduce(parked, { type: 'feedback', activityId: workId(parked, ID), text: 'look again', start: false });
  const live = activityOf(state, ID);
  assert.deepEqual([taskOf(state)?.stage, live?.approval, live?.via], ['Brainstorm', undefined, transitionKey(FEEDBACK)]);
});

test('a stage without approval routes its verdict at once, as today (#693)', () => {
  const { approval: _approval, ...open } = STAGES[0];
  const { state, effects } = stageEnd(flow([SPIKE], [open, ...STAGES.slice(1)]), { verdict: 'spike' });
  assert.deepEqual([taskOf(state)?.stage, activityOf(state, ID)?.approval, columns(effects)], ['Spike', undefined, ['Spiking']]);
});

test('an unrouted verdict on an approval stage awaits with the verdict stored, and approving takes approved (#693)', () => {
  const parked = stageEnd(flow(), { verdict: 'task' }).state;
  assert.deepEqual([taskOf(parked)?.stage, activityOf(parked, ID)?.approval?.verdict], ['Brainstorm', 'task']);
  const { state } = approve(parked);
  assert.deepEqual([taskOf(state)?.stage, activityOf(state, ID)?.via], ['Spec', transitionKey(APPROVED)]);
});

test('a plain hive_done on an approval stage awaits with no verdict, and approving takes approved, as today (#693)', () => {
  const parked = stageEnd(flow()).state;
  const approval = activityOf(parked, ID)?.approval;
  assert.deepEqual([taskOf(parked)?.stage, typeof approval?.since, approval !== undefined && 'verdict' in approval], ['Brainstorm', 'string', false]);
  assert.equal(taskOf(approve(parked).state)?.stage, 'Spec');
});

test('a held verdict approval whose window runs out keeps its verdict, and approving still takes the verdict\'s transition (#693)', () => {
  const parked = stageEnd(flow(TRANSITIONS, CONTINUING), { verdict: 'spike' }).state;
  const ptyId = parked.workers[0].runId!;
  const approval = activityOf(parked, ID)!.approval!;
  const expired = reduce(withApproval(parked, { ...approval, until: past() }), { type: 'approvalExpired', ptyId }).state;
  assert.deepEqual(activityOf(expired, ID)?.approval, { since: approval.since, verdict: 'spike' });
  const { state, effects } = approve(expired);
  assert.deepEqual([taskOf(state)?.stage, columns(effects)], ['Spike', ['Spiking']]);
});

test('a free session\'s hive_done with a routed verdict on an approval stage awaits with the verdict and the session; approving takes the verdict\'s transition (#693, #812)', () => {
  const first = flow();
  const run = first.workers[0].runId!;
  const seen = reduce(first, { type: 'hook', ptyId: run, payload: { hook_event_name: 'SessionStart', cwd: '/tmp/worktrees/hive-1-task-1' } }).state;
  const idle = reduce(reduce(seen, { type: 'stop', ptyId: run }).state, { type: 'exit', ptyId: run }).state;
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, ID) }).state;
  const own = opened.workers.find((s) => s.freeSession)!;
  const parked = reduce(opened, { type: 'done', ptyId: own.runId!, verdict: 'spike', evidence: 'src/daemon.ts:88' }).state;
  const approval = activityOf(parked, ID)?.approval;
  assert.deepEqual([taskOf(parked)?.stage, approval?.verdict, approval?.sessionId, typeof approval?.since], ['Brainstorm', 'spike', own.sessionId, 'string']);
  const { state, effects } = approve(parked);
  assert.deepEqual([taskOf(state)?.stage, columns(effects)], ['Spike', ['Spiking']]);
});
