import { expect, test } from 'vitest';
import { subIssueCount, treeRows } from '@/lib/project-tree';
import { hiveProject } from '../../src/hive-project';
import type { Flow, ProjectItem, Stage, Task } from '../../src/types';
import { row, VIEW } from './project-harness';

// #584: what a list draws, as [id, depth, childCount] per visible line
const lines = (items: readonly ProjectItem[], expanded: readonly ProjectItem[] = items) =>
  treeRows(items, new Set(expanded.map((i) => i.itemId))).map((l) => [l.item.id, l.depth, l.childCount]);

const stage = (name: string): Stage => ({ name, from: {}, prompt: 'x' });
const FLOWS: Flow[] = [{ name: 'build', stages: [stage('spec'), stage('dev')], transitions: [] }, { name: 'ship', stages: [stage('review')], transitions: [] }];
const hiveTask = (n: number, at: string, parent?: number): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '', ...(parent === undefined ? {} : { parent: `local:${parent}` }) },
  stage: at, boardColumn: '', auto: false, created: true,
});

test('two levels nest in order: each child right after its parent, after its earlier siblings\' subtrees (#584 decision 1)', () => {
  const items = Object.freeze([row(1), row(2, { parent: 1 }), row(3, { parent: 2 }), row(4), row(5, { parent: 1 })]);
  expect(lines(items)).toEqual([['1', 0, 2], ['2', 1, 1], ['3', 2, 0], ['5', 1, 0], ['4', 0, 0]]);
});

test('a collapsed parent hides its whole subtree, grandchildren included; nothing expanded shows the roots alone (#584 decision 3)', () => {
  const items = [row(1), row(2, { parent: 1 }), row(3, { parent: 2 }), row(4)];
  expect(lines(items, [items[1]])).toEqual([['1', 0, 1], ['4', 0, 0]]);
  expect(lines(items, [])).toEqual([['1', 0, 1], ['4', 0, 0]]);
});

test('a child whose parent is not in the list is a root (#584 decision 2)', () => {
  expect(lines([row(7, { parent: 99 }), row(8)])).toEqual([['7', 0, 0], ['8', 0, 0]]);
});

test('siblings keep the input\'s order, the sort\'s or the Project\'s (#584 decision 6)', () => {
  expect(lines([row(1), row(5, { parent: 1 }), row(2, { parent: 1 })])).toEqual([['1', 0, 2], ['5', 1, 0], ['2', 1, 0]]);
});

test('a cycle in parent yields roots; a row hanging off the cycle still nests; a row that is its own parent is a root (#584 decision 5)', () => {
  const items = [row(1, { parent: 2 }), row(2, { parent: 1 }), row(3, { parent: 1 }), row(4, { parent: 4 })];
  expect(lines(items)).toEqual([['1', 0, 1], ['3', 1, 0], ['2', 0, 0], ['4', 0, 0]]);
});

test('a hive row nests under the task its local:<n> names (#584 decision 7)', () => {
  const { items } = hiveProject({ flows: FLOWS, tasks: [hiveTask(1, 'spec'), hiveTask(2, 'spec', 1)], activityRecords: [] });
  expect(lines(items)).toEqual([['HIVE-1', 0, 1], ['HIVE-2', 1, 0]]);
});

test('the count is the parent\'s own progress field, found by kind, not by name (#584 decision 8)', () => {
  expect(subIssueCount(row(1, { fields: { Progress: '2/5' } }), VIEW, [])).toEqual({ done: 2, n: 5 });
  const renamed = { fields: [{ name: 'Sub-issues', type: 'progress' as const }], items: [] };
  expect(subIssueCount(row(1, { fields: { 'Sub-issues': '0/3' } }), renamed, [])).toEqual({ done: 0, n: 3 });
});

test('with no progress value, the count is the parent\'s children in the whole view and the closed ones; a source row is never done by its status (#584 decision 9)', () => {
  const items = [row(1), row(2, { parent: 1, closedAt: '2026-10-04T10:00:00Z' }), row(3, { parent: 1, status: 'review' }), row(4, { parent: 9 })];
  expect(subIssueCount(items[0], { fields: [], items }, FLOWS)).toEqual({ done: 1, n: 2 });
  expect(subIssueCount(items[0], { ...VIEW, items }, FLOWS)).toEqual({ done: 1, n: 2 }); // the field exists, the parent has no value
});

test('a hive child is done at the last stage of its flow (#584 decision 9)', () => {
  const view = hiveProject({ flows: FLOWS, tasks: [hiveTask(1, 'spec'), hiveTask(2, 'dev', 1), hiveTask(3, 'review', 1), hiveTask(4, 'spec', 1)], activityRecords: [] });
  expect(subIssueCount(view.items[0], view, FLOWS)).toEqual({ done: 2, n: 3 }); // dev ends build, review ends ship; spec does not
});
