import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { parentOf, progress } from '../src/task-tree.js';
import { END, HIVE_EPIC, type HiveEvent, type Stage, type State, type Task, type Transition } from '../src/types.js';
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

const moveTo = (taskId: string, stage: string): HiveEvent => ({ type: 'moveToStage', taskId, stage });
// The goal stamped as leaf 3's write stamps it, and its two hive children, every one in Spec
const tree = (): State => {
  const goal = run(create(base(), 'Goal'), { type: 'markEpic', taskId: 'local:1', epic: HIVE_EPIC });
  return deepFreeze(create(create(goal, 'One', 'local:1'), 'Two', 'local:1'));
};
const epicStageOf = (state: State): string | undefined => taskIn(state, 'local:1')?.stage;

test('HIVE_EPIC is the rule a new GitHub source\'s epics get; the fill never takes a hive epic, as it takes the same task unstamped (#782)', () => {
  assert.deepEqual(HIVE_EPIC, { follows: 'aheadThenBehind', switchAt: 'Build' });
  const goal = create(base(), 'Goal');
  const spawned = (state: State) => reduce(state, { type: 'setMax', max: 1 }).effects.filter((e) => e.type === 'spawn');
  assert.equal(spawned(goal).length, 1, 'unstamped, a free worker takes it');
  assert.deepEqual(spawned(run(goal, { type: 'markEpic', taskId: 'local:1', epic: HIVE_EPIC })), []);
});

test('a hive epic follows its hive children by aheadThenBehind: the faster child up to Build, then never ahead of the slower one (#782)', () => {
  assert.equal(epicStageOf(tree()), 'Spec');
  const ahead = run(tree(), moveTo('local:2', 'Review'));
  assert.equal(epicStageOf(ahead), 'Build', 'ahead, but no further than Build');
  const both = run(ahead, moveTo('local:3', 'Review'));
  assert.equal(epicStageOf(both), 'Review');
  const one = run(both, moveTo('local:2', 'Done'));
  assert.equal(epicStageOf(one), 'Review', 'past Build it stays with the slower child');
});

const POLL: HiveEvent = { type: 'poll', items: [] }; // no source: what runs the due stage actions and the epic's next pass
const deleted = (state: State, itemId: string): State =>
  run(withWork(state, itemId, { worktree: `/w/${itemId}`, deleting: true }), { type: 'taskDeleted', taskId: itemId });

test('a hive child that leaves, through the last stage\'s END exit or deleted, is closed on its hive parent, and progress counts it done (#782)', () => {
  const ended = run(tree(), moveTo('local:2', 'Done'), moveTo('local:3', 'Review'), POLL);
  assert.equal(taskIn(ended, 'local:2'), undefined, 'Done acted: nothing to delete, out through its END exit');
  assert.deepEqual(taskIn(ended, 'local:1')?.item.closedChildren, ['local:2']);
  assert.deepEqual(progress(ended.tasks, 'local:1', 'Done'), { done: 1, total: 2 });
  const gone = deleted(ended, 'local:3');
  assert.deepEqual(taskIn(gone, 'local:1')?.item.closedChildren, ['local:2', 'local:3']);
  assert.deepEqual(progress(gone.tasks, 'local:1', 'Done'), { done: 2, total: 2 });
});

test('both hive children gone: at the next reduction the epic goes into Done and out through its END exit, as a GitHub epic does (#782)', () => {
  const gone = deleted(run(tree(), moveTo('local:2', 'Done'), POLL), 'local:3');
  assert.notEqual(taskIn(gone, 'local:1'), undefined, 'the mark is written after the epic pass: the epic reads it at the next reduction');
  assert.deepEqual(run(gone, POLL).tasks, [], 'every child done: into Done, and Done has no after, so out at once');
});

test('a reduction where no hive task left returns the state the step left, as before (#782)', () => {
  const before = tree();
  assert.equal(reduce(before, { type: 'tick' }).state, before);
});

test('createTask with epic is born an epic: with a free worker and a prompt stage the fill does not start it, as it starts the same task without (#783)', () => {
  const event: HiveEvent = { type: 'createTask', title: 'Inner', body: '', stage: 'Spec', prefix: 'HIVE', workspace: 'hive', auto: true };
  assert.equal(reduce(base(1), event).effects.filter((e) => e.type === 'spawn').length, 1, 'without epic, the free worker takes it');
  const born = reduce(deepFreeze(base(1)), { ...event, epic: HIVE_EPIC });
  assert.deepEqual(born.effects.filter((e) => e.type === 'spawn'), []);
  assert.deepEqual(born.state.tasks.find((t) => t.item.itemId === 'local:1')?.item.epic, HIVE_EPIC);
});
