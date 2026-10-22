import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { taskAnswer, taskComments } from '../src/mcp-task.js';
import { initialState } from '../src/orchestrator.js';
import type { Item, State, Task, TaskComment, Worker } from '../src/types.js';
import { activityIdOf, withKeptRecord, withLocal, withWork } from './fixtures/work.js';

const ITEM_ID = 'gh:I7';
type Fields = Partial<Item> & Pick<Item, 'itemId' | 'id'>;
const taskOf = (fields: Fields, stage: string): Task =>
  ({ item: { title: `Task ${fields.id}`, body: '', url: `https://github.com/acme/r/issues/${fields.id}`, source: 'gh', ...fields }, stage, boardColumn: 'Ready', auto: true });

const LEAF: Task = { ...taskOf({ itemId: ITEM_ID, id: '7', title: 'hive_task', body: 'The worker reads its task.' }, 'plan'), workspace: 'hive' };
const LEAF_ANSWER = {
  id: '7', itemId: ITEM_ID, title: 'hive_task', body: 'The worker reads its task.', url: 'https://github.com/acme/r/issues/7',
  source: 'gh', workspace: 'hive', stage: 'plan', result: { spec: 'docs/s.md', issue: 7 },
};
const STAGE_WORKER: Worker = { id: 'w1', runId: 'p1', status: 'working', activityId: activityIdOf(ITEM_ID) };
const LOCAL_WORKER: Worker = { id: 'w2', runId: 'p2', status: 'working', activityId: localActivityId('hive') };
const COMMENT: TaskComment = { author: 'someone', createdAt: '2026-10-20T10:00:00Z', body: 'Comments always.', url: 'https://github.com/acme/r/issues/7#issuecomment-1' };

// Two records of the task, the older first: what resultOf merges, a newer key winning
function stateWith(tasks: Task[], workers: Worker[] = [STAGE_WORKER]): State {
  const kept = withKeptRecord({ ...initialState(1), tasks, workers }, ITEM_ID, 'old', { result: { spec: 'docs/old.md', issue: 7 } });
  return withWork(kept, ITEM_ID, {}, { result: { spec: 'docs/s.md' } });
}

test('taskAnswer gives a stage run and a free session on the task the same answer: identity, the current stage and every result merged, a newer key winning (#7)', () => {
  const state = stateWith([LEAF]);
  assert.deepEqual(taskAnswer(state, STAGE_WORKER, 'hive'), { task: LEAF_ANSWER });
  assert.deepEqual(taskAnswer(state, { ...STAGE_WORKER, freeSession: true }, 'hive'), { task: LEAF_ANSWER });
  const { workspace: _workspace, ...unplaced } = LEAF_ANSWER;
  assert.deepEqual(taskAnswer(state, STAGE_WORKER, undefined), { task: unplaced }, 'no workspace resolved: none named');
});

test('a session with no task answers task: null (#7)', () => {
  assert.deepEqual(taskAnswer(withLocal(stateWith([LEAF], [LOCAL_WORKER]), 'hive'), LOCAL_WORKER, 'hive'), { task: null });
});

const TREE: Task = {
  ...LEAF,
  item: {
    ...LEAF.item, parent: 'gh:I1', children: ['gh:I8', 'gh:I9', 'gh:I10'], closedChildren: ['gh:I10'],
    blockers: { blockedBy: [{ id: '5', title: 'Blocker', state: 'open' }, { id: 'acme/o#2', title: 'Elsewhere', state: 'closed' }], blocking: [{ id: '8', title: 'Task 8', state: 'open' }] },
  },
};
const PARENT = taskOf({ itemId: 'gh:I1', id: '1', title: 'Goal' }, 'decomposition');
const CHILD = taskOf({ itemId: 'gh:I8', id: '8' }, 'spec');
const BLOCKER = taskOf({ itemId: 'gh:I5', id: '5', title: 'Blocker' }, 'build');

test('the tree: parent, children and blockers carry id, title and stage when the Hive holds them, the itemId alone when not, closed: true on a closed child (#7)', () => {
  const answer = taskAnswer(stateWith([TREE, PARENT, CHILD, BLOCKER]), STAGE_WORKER, 'hive').task;
  assert.deepEqual(answer?.parent, { id: '1', title: 'Goal', stage: 'decomposition' });
  assert.deepEqual(answer?.children, [{ id: '8', title: 'Task 8', stage: 'spec' }, { id: 'gh:I9' }, { id: 'gh:I10', closed: true }]);
  assert.deepEqual(answer?.blockers, {
    blockedBy: [{ id: '5', title: 'Blocker', state: 'open', stage: 'build' }, { id: 'acme/o#2', title: 'Elsewhere', state: 'closed' }],
    blocking: [{ id: '8', title: 'Task 8', state: 'open', stage: 'spec' }],
  });
  assert.deepEqual(taskAnswer(stateWith([TREE]), STAGE_WORKER, 'hive').task?.parent, { id: 'gh:I1' }, 'a parent the Hive does not hold');
});

const CREATED: Task = { item: { itemId: 'local:3', id: 'HIVE-3', title: 'Mine', body: 'b', url: '' }, stage: 'spec', boardColumn: '', auto: true, created: true };

test('a leaf leaves parent, children and blockers out; a blocker never takes the stage of a task of another source under the same id (#7)', () => {
  const leaf = taskAnswer(stateWith([LEAF]), STAGE_WORKER, 'hive').task ?? {};
  for (const key of ['parent', 'children', 'blockers']) assert.equal(Object.hasOwn(leaf, key), false, key);
  const created5: Task = { ...CREATED, item: { ...CREATED.item, itemId: 'local:5', id: '5' } };
  const blockers = taskAnswer(stateWith([TREE, created5]), STAGE_WORKER, 'hive').task?.blockers;
  assert.deepEqual(blockers?.blockedBy[0], { id: '5', title: 'Blocker', state: 'open' });
});

test('a task created in the Hive names no source and reads no comments, even from a source that has them (#7)', async () => {
  const worker: Worker = { ...STAGE_WORKER, activityId: activityIdOf('local:3') };
  const state = withWork({ ...initialState(1), tasks: [CREATED], workers: [worker] }, 'local:3');
  assert.deepEqual(taskAnswer(state, worker, 'hive'), { task: { id: 'HIVE-3', itemId: 'local:3', title: 'Mine', body: 'b', url: '', workspace: 'hive', stage: 'spec' } });
  assert.deepEqual(await taskComments({ comments: async () => [COMMENT] }, CREATED), {});
});

test('taskComments reads the comments by the task\'s itemId, leaves them out for a source without comments, and turns a throw into commentsError (#7)', async () => {
  const asked: string[] = [];
  const reading = { comments: async (itemId: string): Promise<TaskComment[]> => { asked.push(itemId); return [COMMENT]; } };
  assert.deepEqual(await taskComments(reading, LEAF), { comments: [COMMENT] });
  assert.deepEqual(asked, [ITEM_ID]);
  assert.deepEqual(await taskComments({}, LEAF), {});
  assert.deepEqual(await taskComments(undefined, LEAF), {});
  const failing = { comments: async (): Promise<TaskComment[]> => { throw new Error('API rate limit exceeded'); } };
  assert.deepEqual(await taskComments(failing, LEAF), { commentsError: 'API rate limit exceeded' });
});
