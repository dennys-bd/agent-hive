import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allDone, depthOf, descendants, epicStage, lineage, parentOf, progress, rootOf, treeProgress, treeStarted } from '../src/task-tree.js';
import type { EpicFollows, Item, Task } from '../src/types.js';

const LAST = 'Done';
type Links = Pick<Item, 'parent' | 'children' | 'closedChildren' | 'epic'>;
const task = (itemId: string, stage: string, links: Links = {}): Task => ({
  item: { itemId, id: itemId, title: itemId, body: '', url: '', ...links }, stage, boardColumn: '', auto: true,
});
// The spec's example: R lists A (a task, listing A1 in the last stage and A2 in Build) and B (no task, closed on GitHub)
const TREE: Task[] = [
  task('R', 'Build', { children: ['A', 'B'], closedChildren: ['B'] }),
  task('A', 'Build', { parent: 'R', children: ['A1', 'A2'] }),
  task('A1', LAST, { parent: 'A' }),
  task('A2', 'Build', { parent: 'A' }),
];
const without = (itemId: string): Task[] => TREE.filter((t) => t.item.itemId !== itemId);
const ids = (tasks: Task[]): string[] => tasks.map((t) => t.item.itemId);
// GitHub forbids it, but the wire is not trusted: X and Y are each other's parent, and Y lists X twice and itself
const CYCLE: Task[] = [
  task('X', 'Build', { parent: 'Y', children: ['Y'] }),
  task('Y', LAST, { parent: 'X', children: ['X', 'Y', 'X'] }),
];

test('parentOf and rootOf walk up through the task list; a parent absent from it reads as none (#28)', () => {
  assert.equal(parentOf(TREE, 'A1')?.item.itemId, 'A');
  assert.equal(parentOf(TREE, 'R'), undefined);
  assert.equal(rootOf(TREE, 'A1')?.item.itemId, 'R');
  assert.equal(rootOf(TREE, 'R')?.item.itemId, 'R', 'a root is its own root');
  assert.equal(parentOf(without('R'), 'A'), undefined, 'R filtered out: A has no parent');
  assert.equal(rootOf(without('R'), 'A1')?.item.itemId, 'A', 'A is a root of its own');
  assert.equal(rootOf(TREE, 'nope'), undefined);
});

test('depthOf is 0 for a root and counts the steps below it (#28)', () => {
  assert.deepEqual(['R', 'A', 'A1'].map((id) => depthOf(TREE, id)), [0, 1, 2]);
  assert.equal(depthOf(without('R'), 'A1'), 1, 'counted from the root the list has');
  assert.equal(depthOf(TREE, 'nope'), 0);
});

test('descendants goes depth first in sub-issue order, skips ids with no task, and a cycle neither loops nor repeats (#28)', () => {
  assert.deepEqual(ids(descendants(TREE, 'R')), ['A', 'A1', 'A2'], 'B has no task');
  assert.deepEqual(ids(descendants(TREE, 'A1')), []);
  assert.deepEqual(ids(descendants(CYCLE, 'X')), ['Y'], 'the task itself, the duplicate and the self-reference are skipped');
  assert.equal(rootOf(CYCLE, 'X')?.item.itemId, 'Y', 'the walk up stops at the repeat');
  assert.equal(depthOf(CYCLE, 'X'), 1);
});

test('lineage lists the task and its ancestors, nearest first; an item that is no task gives none, and a cycle stops at the repeat (#35)', () => {
  assert.deepEqual(ids(lineage(TREE, 'A1')), ['A1', 'A', 'R']);
  assert.deepEqual(ids(lineage(TREE, 'nope')), []);
  assert.deepEqual(ids(lineage(CYCLE, 'X')), ['X', 'Y']);
});

test('progress counts a direct child in the last stage and a closed child with no task as done, an open one with no task as not (#28)', () => {
  assert.deepEqual(progress(TREE, 'R', LAST), { done: 1, total: 2 }, 'B closed counts; A is outside the last stage');
  assert.deepEqual(progress(TREE, 'A', LAST), { done: 1, total: 2 });
  const mixed = [task('P', 'Build', { children: ['D', 'E', 'F'], closedChildren: ['E'] }), task('D', LAST, { parent: 'P' })];
  assert.deepEqual(progress(mixed, 'P', LAST), { done: 2, total: 3 }, 'F has no task and is open');
  assert.deepEqual(progress(TREE, 'A1', LAST), { done: 0, total: 0 }, 'a leaf');
});

test('treeProgress counts every node below the task, intermediate parents and a child with no task as one node each (#28)', () => {
  assert.deepEqual(treeProgress(TREE, 'R', LAST), { done: 2, total: 4 }, 'A, A1, A2, B: A1 and B are done');
  assert.deepEqual(treeProgress(TREE, 'A', LAST), { done: 1, total: 2 });
  assert.deepEqual(treeProgress(CYCLE, 'X', LAST), { done: 1, total: 1 }, 'Y once, nothing loops');
});

test('treeStarted is true when any task of the item\'s whole tree meets the predicate, false otherwise (#28)', () => {
  const isA2 = (t: Task): boolean => t.item.itemId === 'A2';
  assert.equal(treeStarted(TREE, 'A1', isA2), true, 'a sibling counts: the walk starts at the root');
  assert.equal(treeStarted(TREE, 'R', () => false), false);
  const orphan = [...TREE, task('C', 'Build', { parent: 'Q' })];
  assert.equal(treeStarted(orphan, 'C', isA2), false, 'Q is no task: C is its own root');
  assert.equal(treeStarted(CYCLE, 'X', (t) => t.stage === LAST), true);
});

// #31: the flow in pipeline order, switching at Build; E lists c1 and c2
const FLOW = ['Backlog', 'Spec', 'Build', 'Review', LAST].map((name) => ({ name }));
const epicOf = (follows: EpicFollows, children = ['c1', 'c2']): Task => task('E', 'Backlog', { children, epic: { follows, switchAt: 'Build' } });
const stageFor = (follows: EpicFollows, [first, second]: [string, string]): string | undefined => {
  const tasks = [epicOf(follows), task('c1', first, { parent: 'E' }), task('c2', second, { parent: 'E' })];
  return epicStage(tasks, FLOW, tasks[0]);
};

test('epicStage puts a behind epic at its furthest-behind child and an ahead one at its furthest-ahead, in pipeline order (#31)', () => {
  assert.equal(stageFor('behind', ['Review', 'Spec']), 'Spec');
  assert.equal(stageFor('ahead', ['Review', 'Spec']), 'Review');
});

test('epicStage under aheadThenBehind follows the furthest ahead up to switchAt, waits there, then follows the furthest behind (#31)', () => {
  assert.equal(stageFor('aheadThenBehind', ['Backlog', 'Spec']), 'Spec', 'before switchAt: the furthest ahead');
  assert.equal(stageFor('aheadThenBehind', ['Spec', 'Build']), 'Build', 'at switchAt');
  assert.equal(stageFor('aheadThenBehind', ['Spec', 'Review']), 'Build', 'one child is past switchAt: the epic waits there for the other');
  assert.equal(stageFor('aheadThenBehind', ['Review', LAST]), 'Review', 'both past switchAt: the furthest behind');
});

test('epicStage is undefined when no child is a task in a stage of the flow, and for a task with no epic stamp (#31)', () => {
  assert.equal(epicStage([epicOf('behind', ['gone'])], FLOW, epicOf('behind', ['gone'])), undefined, 'the child is no task');
  assert.equal(stageFor('behind', ['Nowhere', 'Nowhere']), undefined, 'a stage the flow lost');
  const plain = task('P', 'Backlog', { children: ['c1'] });
  assert.equal(epicStage([plain, task('c1', 'Build', { parent: 'P' })], FLOW, plain), undefined);
});

test('allDone holds when every direct child sits in the last stage or is closed with no task; never for a leaf (#31)', () => {
  const both = [epicOf('behind'), task('c1', LAST, { parent: 'E' }), task('c2', LAST, { parent: 'E' })];
  assert.equal(allDone(both, 'E', LAST), true);
  const closed = [task('E', 'Build', { children: ['c1', 'c2'], closedChildren: ['c2'] }), task('c1', LAST, { parent: 'E' })];
  assert.equal(allDone(closed, 'E', LAST), true, 'c2 left the Hive closed');
  assert.equal(allDone([epicOf('behind'), task('c1', LAST, { parent: 'E' }), task('c2', 'Build', { parent: 'E' })], 'E', LAST), false);
  assert.equal(allDone([task('L', LAST)], 'L', LAST), false, 'no child: nothing to be done');
});
