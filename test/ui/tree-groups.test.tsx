import { expect, test } from 'vitest';
import { collapseKey, groupTasks, hasTree, inTree, nodeRows, outlineRows, segmentTone, treeSegments, type TreeGroup } from '@/lib/tree-groups';
import type { Item, Task } from '../../src/types';
import { activityIdOf, taskPairOf } from '../fixtures/work';

type Links = Pick<Item, 'parent' | 'children' | 'closedChildren'>;
const task = (itemId: string, links: Links = {}, stage = 'Build'): Task => ({
  item: { itemId, id: itemId, title: itemId, body: '', url: '', ...links }, stage, boardColumn: '', auto: true,
});
// R lists A and B, B lists B1; S lists S1; X and Y are in no tree
const R = task('R', { children: ['A', 'B'] });
const A = task('A', { parent: 'R' });
const B = task('B', { parent: 'R', children: ['B1'] });
const B1 = task('B1', { parent: 'B' });
const S = task('S', { children: ['S1'] });
const S1 = task('S1', { parent: 'S' });
const X = task('X');
const Y = task('Y');
const ALL = [X, B1, R, Y, A, B, S, S1];
// Each group as its root's id (none for "no tree") and its cards as id:depth
const shape = (groups: TreeGroup[]): Array<[string, string[]]> =>
  groups.map((g) => [g.root?.item.itemId ?? 'none', g.tasks.map(({ task: t, depth }) => `${t.item.itemId}:${depth}`)]);

test('groupTasks puts a root, its two children and a grandchild in one group, depth first, then the tasks in no tree under "no tree" (#34)', () => {
  expect(shape(groupTasks(ALL, [X, B1, R, Y, A, B]))).toEqual([['R', ['R:0', 'A:1', 'B:1', 'B1:2']], ['none', ['X:0', 'Y:0']]]);
});

test('groupTasks names the real root for a node holding only a deep child or missing its root, and orders trees by their first task in the node (#34)', () => {
  expect(shape(groupTasks(ALL, [B1]))).toEqual([['R', ['B1:2']]]);
  expect(shape(groupTasks(ALL, [A, B]))).toEqual([['R', ['A:1', 'B:1']]]);
  expect(shape(groupTasks(ALL, [S1, Y, A, S]))).toEqual([['S', ['S:0', 'S1:1']], ['R', ['A:1']], ['none', ['Y:0']]]);
});

test('hasTree is true only with a parent or a child task in the list; segmentTone reads done, empty or the child\'s state; collapseKey joins the stage and the root or none (#34)', () => {
  expect(hasTree([X, Y, task('Q', { parent: 'gone' })])).toBe(false);
  expect(hasTree([X, A, R])).toBe(true);
  // D sits in the last stage, C is at work, N has no activity, E has no task and is closed, F has no task and is open
  const P = task('P', { children: ['D', 'C', 'N', 'E', 'F'], closedChildren: ['E'] });
  const pair = taskPairOf('C');
  const state = {
    tasks: [P, task('D', { parent: 'P' }, 'Done'), task('C', { parent: 'P' }), task('N', { parent: 'P' })],
    workers: [{ id: 'w', status: 'working' as const, activityId: activityIdOf('C'), runId: 'W' }],
    activities: [pair.activity], activityRecords: [pair.record],
  };
  expect(['D', 'C', 'N', 'E', 'F'].map((id) => segmentTone(state, P, id, 'Done'))).toEqual(['done', 'working', 'new', 'done', 'empty']);
  expect([collapseKey('Build', R), collapseKey('Build')]).toEqual(['Build\u0000R', 'Build\u0000none']);
});

test('nodeRows gives each group row the itemIds of its tasks in the node, a collapsed group\'s included (#35)', () => {
  const rows = nodeRows(ALL, [X, B1, R, Y, A, B], 'Build', [collapseKey('Build', R)]);
  const groups = rows.flatMap((row) => (row.kind === 'group' ? [[row.root?.item.itemId ?? 'none', row.itemIds]] : []));
  expect(groups).toEqual([['R', ['R', 'A', 'B', 'B1']], ['none', ['X', 'Y']]]);
});

// #36: T lists T1, T2 and T3; T1 lists T11 and T12; T3 has no task and GitHub closed it. T1 is at work, T11 sits in the last stage
const T = task('T', { children: ['T1', 'T2', 'T3'], closedChildren: ['T3'] });
const T1 = task('T1', { parent: 'T', children: ['T11', 'T12'] });
const T11 = task('T11', { parent: 'T1' }, 'Done');
const T12 = task('T12', { parent: 'T1' });
const T2 = task('T2', { parent: 'T' });
const FAMILY = [T12, T, T2, T11, T1];

test('treeSegments walks every node below the root depth first, the closed child with no task included as done, each tone segmentTone\'s; no root, no segment (#36)', () => {
  const pair = taskPairOf('T1');
  const state = {
    tasks: FAMILY, workers: [{ id: 'w', status: 'working' as const, activityId: activityIdOf('T1'), runId: 'W' }],
    activities: [pair.activity], activityRecords: [pair.record],
  };
  expect(treeSegments(state, 'T', 'Done')).toEqual([
    { id: 'T1', tone: 'working' }, { id: 'T11', tone: 'done' }, { id: 'T12', tone: 'new' }, { id: 'T2', tone: 'new' }, { id: 'T3', tone: 'done' },
  ]);
  expect(treeSegments(state, 'gone', 'Done')).toEqual([]);
});

test('outlineRows lists the root and its descendant tasks with their depths, skips the child with no task, and drops a collapsed parent\'s subtree while keeping the parent (#36)', () => {
  // Each row as id:depth, then ⌄ on a parent, › on a collapsed one
  const rows = (collapsed: string[]): string[] => outlineRows(FAMILY, 'T', collapsed)
    .map(({ task: t, depth, hasChildren, isCollapsed }) => `${t.item.itemId}:${depth}${hasChildren ? (isCollapsed ? '›' : '⌄') : ''}`);
  expect(rows([])).toEqual(['T:0⌄', 'T1:1⌄', 'T11:2', 'T12:2', 'T2:1']);
  expect(rows(['T1', 'gone'])).toEqual(['T:0⌄', 'T1:1›', 'T2:1']);
  expect(rows(['T'])).toEqual(['T:0›']);
  expect(outlineRows(FAMILY, 'gone', [])).toEqual([]);
  expect([inTree(FAMILY, T2), inTree(ALL, X)]).toEqual([true, false]);
});
