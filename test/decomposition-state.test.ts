import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, resultOf } from '../src/activities.js';
import { describeEvent } from '../src/log.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { Item, Stage, State } from '../src/types.js';
import { chained } from './fakes.js';

// A decomposition's write as the reducer records it (#865): one decompositionIssue per step, keyed by task, a pure result merge; and the
// close that ends a local goal once its tree is on GitHub.

const ID = 'board:item1';
const STAGES: Stage[] = [
  { name: 'goal', from: { board: ['Goals'] }, prompt: '/hive:decomposition {url}', approval: true },
  { name: 'spec', from: { board: ['Ready'] }, prompt: '/hive:new-spec {url}', session: 'continue' }, // goes on in the session: the approval holds the run
];
const item: Item = { itemId: ID, id: '1', title: 'Site for XPTO', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
// The run's hive_done with the file's path, then its Stop: the stage awaits approval with the run held
function stageEnd(state: State): State {
  const ptyId = state.workers[0].runId!;
  const done = reduce(state, { type: 'done', ptyId, result: { decomposition: 'decomposition.md' } }).state;
  return reduce(done, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } }).state;
}
const awaiting = (): State =>
  stageEnd(reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(STAGES) }, { type: 'poll', source: 'board', items: [{ item, column: 'Goals' }] }).state);

test('decompositionIssue merges each step into result.decompositionIssues without touching the state it read; no effect, no worker change, still awaiting (#865)', () => {
  const before = deepFreeze(awaiting());
  const one = reduce(before, { type: 'decompositionIssue', taskId: ID, id: 'design', number: 1 });
  const two = reduce(one.state, { type: 'decompositionIssue', taskId: ID, id: '1', number: 12 });
  assert.deepEqual(resultOf(two.state, ID), { decomposition: 'decomposition.md', decompositionIssues: { design: 1, '1': 12 } });
  assert.deepEqual([one.effects, two.effects], [[], []]);
  assert.deepEqual(two.state.workers, before.workers);
  assert.equal(activityOf(two.state, ID)?.approval?.since, activityOf(before, ID)?.approval?.since);
});

test('decompositionIssue on a task the Hive does not hold changes nothing (#865)', () => {
  const state = deepFreeze(awaiting());
  assert.equal(reduce(state, { type: 'decompositionIssue', taskId: 'board:gone', id: '1', number: 3 }).state, state);
});

test('the log line names the task, the key and the number, never a title (#865)', () => {
  assert.equal(describeEvent({ type: 'decompositionIssue', taskId: ID, id: '1.2', number: 103 }), 'decompositionIssue #board:item1 1.2=#103');
});

test('closeTask takes a local goal whose decomposition is written even while its approval holds the run: the run is killed and its worker freed (#865)', () => {
  const created = reduce({ ...initialState(1), workspaces: ['hive'], ...chained(STAGES) }, { type: 'createTask', title: 'Site for XPTO', body: '', stage: 'goal', prefix: 'HIVE', workspace: 'hive', auto: true }).state;
  const ptyId = created.workers[0].runId!;
  const held = deepFreeze(stageEnd(created));
  assert.equal(held.workers[0].status, 'approval');
  assert.equal(reduce(held, { type: 'closeTask', taskId: 'local:1' }).state, held, 'not written: the held run keeps it');
  const written = reduce(held, { type: 'decompositionIssue', taskId: 'local:1', id: 'done', number: 40 }).state;
  const { state, effects } = reduce(written, { type: 'closeTask', taskId: 'local:1' });
  assert.deepEqual([state.tasks.length, state.workers[0].status], [0, 'empty']);
  assert.deepEqual(effects.flatMap((e) => (e.type === 'kill' ? [e.ptyId] : [])), [ptyId]);
});

// #556: the stamp the route sends for a goal whose source runs epics: show or hide
const EPIC: NonNullable<Item['epic']> = { follows: 'aheadThenBehind', switchAt: 'spec' };
const goalOf = (state: State) => state.tasks.find((t) => t.item.itemId === ID);

test('markEpic stamps item.epic on the task without touching the state it read; no effect, no worker change, still awaiting in its stage (#556)', () => {
  const before = deepFreeze(awaiting());
  const { state, effects } = reduce(before, { type: 'markEpic', taskId: ID, epic: EPIC });
  assert.deepEqual(goalOf(state)?.item.epic, EPIC);
  assert.deepEqual([effects, goalOf(state)?.stage, state.workers], [[], 'goal', before.workers]);
  assert.equal(activityOf(state, ID)?.approval?.since, activityOf(before, ID)?.approval?.since);
  assert.equal(goalOf(before)?.item.epic, undefined, 'the state read is untouched');
});

test('markEpic on a task the Hive does not hold changes nothing (#556)', () => {
  const state = deepFreeze(awaiting());
  assert.equal(reduce(state, { type: 'markEpic', taskId: 'board:gone', epic: EPIC }).state, state);
});

test('the markEpic log line names the task only, never a title (#556)', () => {
  assert.equal(describeEvent({ type: 'markEpic', taskId: ID, epic: EPIC }), 'markEpic #board:item1');
});

test('a goal stamped then approved with its run held: the run is killed, nothing spawns, and it waits as an epic in the approved stage until its children are listed (#556)', () => {
  const held = awaiting();
  const ptyId = held.workers[0].runId!;
  const stamped = deepFreeze(reduce(held, { type: 'markEpic', taskId: ID, epic: EPIC }).state);
  const { state, effects } = reduce(stamped, { type: 'approve', activityId: activityOf(stamped, ID)!.id });
  assert.deepEqual([goalOf(state)?.stage, goalOf(state)?.item.epic, state.workers[0].status], ['spec', EPIC, 'empty']);
  assert.deepEqual(effects.flatMap((e) => (e.type === 'kill' ? [e.ptyId] : [])), [ptyId], 'answer -> canContinue -> goesOn skips the epic: the run ends');
  assert.equal(effects.some((e) => e.type === 'spawn'), false, 'the freed worker finds no candidate: isIdle drops the epic');
});

const CHILD: Item = { itemId: 'board:item2', id: '2', title: 'Backend', body: '', url: 'https://github.com/o/r/issues/2', source: 'board', parent: ID };

test('with its children already listed, the approved epic follows them to their stage in the same reduction, and only a child may spawn (#556)', () => {
  const held = awaiting();
  const ptyId = held.workers[0].runId!;
  // the worker is held by the goal's approval, so this poll starts no child
  const listed = reduce(held, { type: 'poll', source: 'board', items: [{ item: { ...item, children: [CHILD.itemId] }, column: 'Goals' }, { item: CHILD, column: 'Goals' }] }).state;
  const stamped = deepFreeze(reduce(listed, { type: 'markEpic', taskId: ID, epic: EPIC }).state);
  assert.equal(goalOf(stamped)?.stage, 'goal', 'its child is in goal: followEpics has nowhere to move it yet');
  const { state, effects } = reduce(stamped, { type: 'approve', activityId: activityOf(stamped, ID)!.id });
  assert.equal(goalOf(state)?.stage, 'goal', 'approved into spec, then followEpics put it back with its child');
  assert.deepEqual(effects.flatMap((e) => (e.type === 'kill' ? [e.ptyId] : [])), [ptyId]);
  assert.equal(effects.some((e) => e.type === 'spawn' && e.task.item.itemId === ID), false);
});
