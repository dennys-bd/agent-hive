import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent } from '../src/log.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { seenOne } from '../src/tasks.js';
import type { Item, SourceItem, Stage, State, Task } from '../src/types.js';

// A field write's re-read item (#686): the poll's one-task step applied to that task alone, through the reducer.

const STAGES: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: 'x' }, { name: 'review', from: { board: ['In review'] }, prompt: 'y' }];
const item = (n: number, title = `T${n}`): Item => ({ itemId: `board:I${n}`, id: String(n), title, body: '', url: `https://github.com/acme/r/issues/${n}`, source: 'board' });
const listed = (n: number, column = 'Ready', title?: string): SourceItem => ({ item: item(n, title), column });
const AT = '2026-10-09T12:00:00.000Z'; // seenOne's clock (#889)
// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
// Two tasks of board in Ready (dev); maxConcurrent 0 keeps the fill from starting either
const polled = (): State => deepFreeze(reduce({ ...initialState(0), syncs: { board: {} }, stages: STAGES }, { type: 'poll', source: 'board', items: [listed(1), listed(2)] }).state);
const taskOf = (state: State, n: number): Task | undefined => state.tasks.find((c) => c.item.itemId === `board:I${n}`);

test('itemRead refreshes its task alone: the item as re-read; the other task, the source order and the sync stamp stay (#686)', () => {
  const before = polled();
  const after = reduce(before, { type: 'itemRead', source: 'board', itemId: 'board:I1', entry: listed(1, 'Ready', 'Renamed') }).state;
  assert.equal(taskOf(after, 1)?.item.title, 'Renamed');
  assert.equal(taskOf(after, 1)?.stage, 'dev');
  assert.equal(taskOf(after, 2), taskOf(before, 2));
  assert.deepEqual([after.sourceOrder, after.syncs], [before.sourceOrder, before.syncs]);
});

test('itemRead with a new column moves a stopped task into the stage that column enters, as the poll would (#686)', () => {
  const after = reduce(polled(), { type: 'itemRead', source: 'board', itemId: 'board:I1', entry: listed(1, 'In review') }).state;
  assert.deepEqual([taskOf(after, 1)?.stage, taskOf(after, 1)?.boardColumn], ['review', 'In review']);
});

test('itemRead with no entry marks the task missing, as the poll would once the item left the listing (#686)', () => {
  const before = polled();
  const after = reduce(before, { type: 'itemRead', source: 'board', itemId: 'board:I1' }).state;
  assert.equal(taskOf(after, 1)?.missing, true);
  assert.equal(taskOf(after, 2), taskOf(before, 2));
});

test('itemRead on an unknown item, an item of another source or a local task leaves the state as it is (#686)', () => {
  const before = polled();
  assert.equal(reduce(before, { type: 'itemRead', source: 'board', itemId: 'board:I9', entry: listed(9) }).state, before);
  assert.equal(reduce(before, { type: 'itemRead', source: 'notes', itemId: 'board:I1' }).state, before);
  const local: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'local', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true, created: true };
  const withLocal = deepFreeze({ ...before, tasks: [...before.tasks, local] });
  assert.equal(reduce(withLocal, { type: 'itemRead', source: 'board', itemId: 'local:1' }).state, withLocal);
});

test('seenOne is the poll\'s step for one known task: listed, it is seen again; unlisted, it is missing; an orphan stays as it is (#686)', () => {
  const task: Task = { item: item(1), stage: 'dev', boardColumn: 'Ready', auto: true };
  const runs = initialState(0);
  assert.equal(seenOne(task, listed(1, 'Ready', 'New'), STAGES, runs, AT).item.title, 'New');
  assert.equal(seenOne(task, undefined, STAGES, runs, AT).missing, true);
  const orphan: Task = { ...task, orphan: true };
  assert.equal(seenOne(orphan, undefined, STAGES, runs, AT), orphan);
  assert.equal(seenOne(orphan, listed(1), STAGES, runs, AT), orphan);
});

test('the itemRead log line names the source, the item and the column, never a title (#686)', () => {
  assert.equal(describeEvent({ type: 'itemRead', source: 'board', itemId: 'board:I1', entry: listed(1, 'In review') }), 'itemRead source=board #board:I1 column=In review');
  assert.equal(describeEvent({ type: 'itemRead', source: 'board', itemId: 'board:I1' }), 'itemRead source=board #board:I1 unlisted');
});
