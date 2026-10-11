import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followEpics } from '../src/epic-follow.js';
import { initialState } from '../src/orchestrator.js';
import { END, type EpicFollows, type Item, type Stage, type State, type Task, type Transition } from '../src/types.js';
import { move } from './fakes.js';
import { withWork } from './fixtures/work.js';

// The show epic's rule (#31): a pass over the state after the step, pure, its moves written to the source like a move by hand.

// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const STAGES: Stage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' },
  { name: 'build', from: { board: ['Ready'] }, prompt: '/hive-build {url}' },
  { name: 'done', from: { board: ['Done'] } },
];
const COLUMN: Record<string, string> = { spec: 'Backlog', build: 'Ready', done: 'Done' };
// The last stage's done exit out of the Hive, writing Shipped as the task passes
const ENDS: Transition = { from: 'done', to: END, when: 'done', sources: { board: [move('Shipped')] } };
const node = (id: string, extra: Partial<Item> = {}): Item => ({ itemId: `board:${id}`, id, title: id, body: '', url: '', source: 'board', ...extra });
const child = (id: string, stage: string): Task => ({ item: node(id, { parent: 'board:E' }), stage, boardColumn: COLUMN[stage], auto: true });
const epic = (stage: string, children: string[], follows: EpicFollows = 'behind', extra: Partial<Item> = {}): Task => ({
  item: node('E', { children: children.map((id) => `board:${id}`), epic: { follows, switchAt: 'build' }, ...extra }), stage, boardColumn: COLUMN[stage], auto: true,
});
const at = (tasks: Task[], transitions: Transition[] = []): State =>
  deepFreeze({ ...initialState(0), workspaces: ['hive'], syncs: { board: {} }, stages: STAGES, transitions, tasks });
const epicIn = (s: State): Task | undefined => s.tasks.find((t) => t.item.itemId === 'board:E');

test('a child\'s move moves its epic where its rule puts it, with one setColumn to the target\'s first door; the input state is untouched (#31)', () => {
  const before = at([epic('spec', ['c1', 'c2']), child('c1', 'build'), child('c2', 'build')]);
  const { state, effects } = followEpics(before);
  assert.equal(epicIn(state)?.stage, 'build');
  assert.equal(epicIn(state)?.boardColumn, 'Ready', 'the column follows the write');
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:E', column: 'Ready' }]);
  assert.equal(epicIn(before)?.stage, 'spec', 'frozen, and unchanged');
});

test('no move and no effect when the epic already sits where its children put it, or when no child is a task (#31)', () => {
  const placed = at([epic('build', ['c1']), child('c1', 'build')]);
  const same = followEpics(placed);
  assert.equal(same.state, placed);
  assert.deepEqual(same.effects, []);
  const alone = at([epic('spec', ['gone'])]);
  assert.equal(followEpics(alone).state, alone, 'the child is not polled yet, filtered out or closed: the epic stays put');
});

test('every child done, with the last stage\'s done exit to end: the epic leaves the Hive through it, its source writes emitted (#31)', () => {
  const before = at([epic('build', ['c1', 'c2'], 'behind', { closedChildren: ['board:c2'] }), child('c1', 'done')], [ENDS]);
  const { state, effects } = followEpics(before);
  assert.equal(epicIn(state), undefined);
  assert.deepEqual(state.tasks.map((t) => t.item.itemId), ['board:c1']);
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:E', column: 'Shipped' }]);
});

test('every child done and no done exit to end: the epic moves to the last stage and stays there (#31)', () => {
  const { state, effects } = followEpics(at([epic('build', ['c1']), child('c1', 'done')]));
  assert.equal(epicIn(state)?.stage, 'done');
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:E', column: 'Done' }]);
  const again = deepFreeze(state);
  assert.equal(followEpics(again).state, again, 'the next pass leaves it there');
});

test('a sub-epic moves before its parent epic in the same pass, so the parent reads it already moved (#31)', () => {
  const root: Task = { item: node('R', { children: ['board:E'], epic: { follows: 'behind', switchAt: 'build' } }), stage: 'spec', boardColumn: 'Backlog', auto: true };
  const { state } = followEpics(at([root, epic('spec', ['c1'], 'behind', { parent: 'board:R' }), child('c1', 'build')]));
  assert.deepEqual(state.tasks.map((t) => [t.item.itemId, t.stage]), [['board:R', 'build'], ['board:E', 'build'], ['board:c1', 'build']]);
});

test('a task without the epic stamp is never touched; an epic whose source action failed keeps its error and writes nothing again (#31)', () => {
  const parent: Task = { item: node('P', { children: ['board:c1'] }), stage: 'spec', boardColumn: 'Backlog', auto: true };
  const plain = at([parent, child('c1', 'build')]);
  assert.equal(followEpics(plain).state, plain);
  const failed = deepFreeze(withWork(at([epic('build', ['c1']), child('c1', 'done')], [ENDS]), 'board:E', { error: 'archive refused' }));
  const kept = followEpics(failed);
  assert.equal(kept.state, failed);
  assert.deepEqual(kept.effects, []);
});
