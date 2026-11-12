import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { parentOf } from '../src/task-tree.js';
import { END, type HiveEvent, type Stage, type State, type Task, type Transition } from '../src/types.js';
import { flowed } from './fixtures/main-flow.js';
import { withWork } from './fixtures/work.js';

// A task created in the Hive with a parent (#782): linked on both ends under a hive parent, on the child's end only under a source's, and a
// hive epic that follows its hive children, counts a child that left as done and leaves once every one of them is.

// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const STAGES: Stage[] = [
  { name: 'Spec', from: {}, prompt: '/hive:new-spec {url}' },
  { name: 'Build', from: {}, prompt: '/hive:new-build {url}' },
  { name: 'Review', from: {}, prompt: '/hive:new-pr {url}' },
  { name: 'Done', from: {}, action: 'deleteActivity' }, // a fresh task has nothing to delete: the stage moves it on through its END exit at once
];
const ENDS: Transition = { from: 'Done', to: END, when: 'done' };
// No worker: nothing runs unless a test raises the max
const base = (max = 0): State => ({ ...initialState(max), workspaces: ['hive'], ...flowed(STAGES, [ENDS]) });
const create = (state: State, title: string, parent?: string): State =>
  reduce(state, { type: 'createTask', title, body: '', stage: 'Spec', prefix: 'HIVE', workspace: 'hive', auto: true, ...(parent === undefined ? {} : { parent }) }).state;
const run = (state: State, ...events: HiveEvent[]): State => events.reduce((s, e) => reduce(s, e).state, state);
const taskIn = (state: State, itemId: string): Task | undefined => state.tasks.find((t) => t.item.itemId === itemId);

test('createTask with a hive parent: the child holds parent, the parent lists it last among its children, in creation order, once; the input is untouched (#782)', () => {
  const parent = deepFreeze(create(base(), 'Goal'));
  const one = create(parent, 'One', 'local:1');
  assert.equal(taskIn(one, 'local:2')?.item.parent, 'local:1');
  assert.deepEqual(taskIn(one, 'local:1')?.item.children, ['local:2']);
  const two = create(one, 'Two', 'local:1');
  assert.deepEqual(taskIn(two, 'local:1')?.item.children, ['local:2', 'local:3'], 'the second after the first');
  assert.equal(taskIn(parent, 'local:1')?.item.children, undefined, 'frozen, and unchanged');
  const listed = deepFreeze({ ...parent, tasks: parent.tasks.map((t) => ({ ...t, item: { ...t.item, children: ['local:2'] } })) });
  assert.deepEqual(taskIn(create(listed, 'One', 'local:1'), 'local:1')?.item.children, ['local:2'], 'never twice');
});

test('createTask whose parent is no task in the state creates the task with no parent and leaves every other task as it was (#782)', () => {
  const before = deepFreeze(create(base(), 'Goal'));
  const after = create(before, 'Loose', 'local:9');
  assert.equal(Object.hasOwn(taskIn(after, 'local:2')!.item, 'parent'), false);
  assert.equal(taskIn(after, 'local:1'), taskIn(before, 'local:1'), 'the same object');
});

test('createTask under a source\'s task links the child only: its parent keeps the children its source sends, and the tree card still finds it (#782)', () => {
  const source: Task = { item: { itemId: 'board:item1', id: '1', title: 'Epic', body: '', url: '', source: 'board', children: ['board:item2'] }, stage: 'Spec', boardColumn: '', auto: true };
  const before = deepFreeze({ ...base(), tasks: [source] });
  const after = create(before, 'Mine', 'board:item1');
  assert.equal(taskIn(after, 'local:1')?.item.parent, 'board:item1');
  assert.equal(taskIn(after, 'board:item1'), before.tasks[0], 'the poll replaces it whole: a hive child written there would be erased');
  assert.equal(parentOf(after.tasks, 'local:1'), before.tasks[0]);
});

test('a deleted hive parent leaves its children as they are: item.parent kept, parentOf none, so the child shows as a root (#782)', () => {
  const linked = create(create(base(), 'Goal'), 'One', 'local:1');
  const gone = run(withWork(linked, 'local:1', { worktree: '/w/1', deleting: true }), { type: 'taskDeleted', taskId: 'local:1' });
  assert.equal(taskIn(gone, 'local:1'), undefined);
  assert.equal(taskIn(gone, 'local:2')?.item.parent, 'local:1');
  assert.equal(parentOf(gone.tasks, 'local:2'), undefined);
});
