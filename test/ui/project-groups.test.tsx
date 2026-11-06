import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { groupItems, hiveGroups } from '@/lib/project-groups';
import { hiveProject } from '../../src/hive-project';
import type { Flow, Stage, Task } from '../../src/types';
import { VIEW, row } from './project-harness';

beforeEach(() => setLanguage('pt'));

// #583: build holds spec and dev, ship holds review; HIVE-2 has no stage, dev has no task
const stage = (name: string): Stage => ({ name, from: {}, prompt: 'x' });
const FLOWS: Flow[] = [{ name: 'build', stages: [stage('spec'), stage('dev')], transitions: [] }, { name: 'ship', stages: [stage('review')], transitions: [] }];
const task = (n: number, at?: string): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, ...(at === undefined ? {} : { stage: at }), boardColumn: '', auto: false, created: true,
});
const HIVE = hiveProject({ flows: FLOWS, tasks: [task(1, 'review'), task(2), task(3, 'spec')], activityRecords: [] });

test('the hive\'s groups follow the flows\' stage order, name the stage once with no → stage, hide an empty stage and close with sem fluxo (#583)', () => {
  const groups = hiveGroups(HIVE.items, HIVE);
  expect(groups.map((g) => [g.key, g.label, g.items.map((i) => i.id), g.stage])).toEqual([
    ['spec', 'spec', ['HIVE-3'], undefined], ['review', 'review', ['HIVE-1'], undefined], ['', 'sem fluxo', ['HIVE-2'], undefined],
  ]);
  setLanguage('en');
  expect(hiveGroups(HIVE.items, HIVE).at(-1)?.label).toBe('no flow');
});

test('a source\'s status groups keep the Project\'s Status order, each with the stage it enters (#756, #583 decision 13)', () => {
  const groups = groupItems(VIEW.items, { key: 'status', label: 'status' }, VIEW);
  expect(groups.map((g) => [g.label, g.stage])).toEqual([['Todo', 'sem etapa'], ['Ready', '→ dev'], ['Done', 'sem etapa']]);
});

// #696: #602 is In progress, #603 (its child, Backlog) and #604 (its grandchild, Done); #700 is a child whose parent #999 is not listed
const SUB_VIEW = { statuses: [{ name: 'Backlog' }, { name: 'In progress' }, { name: 'Done' }], fields: [] };
const SUBS = [
  row(602, { status: 'In progress', assignees: ['ana'] }), row(603, { status: 'Backlog', parent: 602, assignees: ['bia'] }),
  row(604, { status: 'Done', parent: 603 }), row(700, { status: 'Backlog', parent: 999 }),
];
const idsOf = (groups: ReturnType<typeof groupItems>): [string, string[]][] => groups.map((g) => [g.key, g.items.map((i) => i.id)]);

test('a sub-issue joins its parent\'s status group and no longer appears in its own, an emptied group disappearing (#696)', () => {
  const groups = groupItems(SUBS.slice(0, 2), { key: 'status', label: 'status' }, SUB_VIEW);
  expect(idsOf(groups)).toEqual([['In progress', ['602', '603']]]);
});

test('a grandchild follows its topmost ancestor\'s group (#696)', () => {
  const groups = groupItems(SUBS.slice(0, 3), { key: 'status', label: 'status' }, SUB_VIEW);
  expect(idsOf(groups)).toEqual([['In progress', ['602', '603', '604']]]);
});

test('a child whose parent is not in the list stays flat in its own status\'s group (#696, #584 decision 2)', () => {
  const groups = groupItems(SUBS, { key: 'status', label: 'status' }, SUB_VIEW);
  expect(idsOf(groups)).toEqual([['Backlog', ['700']], ['In progress', ['602', '603', '604']]]);
});

test('the rule holds under a non-status grouping: a child with another value goes where its root is (#696)', () => {
  const groups = groupItems(SUBS.slice(0, 2), { key: 'assignee', label: 'resp.' }, SUB_VIEW);
  expect(idsOf(groups)).toEqual([['ana', ['602', '603']]]);
});

test('a child with no value joins its root\'s group, and a root with no value pulls its valued child into the empty group (#696)', () => {
  const option = { key: 'assignee', label: 'resp.' };
  const unvalued = groupItems([row(1, { assignees: ['ana'] }), row(2, { parent: 1 })], option, SUB_VIEW);
  expect(idsOf(unvalued)).toEqual([['ana', ['1', '2']]]);
  const empty = groupItems([row(1), row(2, { parent: 1, assignees: ['ana'] })], option, SUB_VIEW);
  expect(idsOf(empty)).toEqual([['', ['1', '2']]]);
});

test('rows on a parent cycle stay in their own groups, and a tail off the cycle follows its member (#696)', () => {
  const rows = [row(1, { status: 'Backlog', parent: 2 }), row(2, { status: 'Done', parent: 1 }), row(3, { status: 'In progress', parent: 1 })];
  const groups = groupItems(rows, { key: 'status', label: 'status' }, SUB_VIEW);
  expect(idsOf(groups)).toEqual([['Backlog', ['1', '3']], ['Done', ['2']]]);
});

test('a group keeps the input order when children from other groups interleave (#696)', () => {
  const rows = [
    row(10, { status: 'Backlog' }), row(11, { status: 'Backlog', parent: 20 }), row(20, { status: 'Done' }), row(12, { status: 'Backlog' }),
  ];
  const groups = groupItems(rows, { key: 'status', label: 'status' }, SUB_VIEW);
  expect(idsOf(groups)).toEqual([['Backlog', ['10', '12']], ['Done', ['11', '20']]]);
});

test('the hive groups follow the same rule (#696)', () => {
  const local = (n: number, parent?: number, status?: string) => row(n, { itemId: `local:${n}`, id: `HIVE-${n}`, ...(status === undefined ? {} : { status }), ...(parent === undefined ? {} : { parent }) });
  const groups = hiveGroups([local(1, undefined, 'spec'), local(2, 1, 'review')], SUB_VIEW);
  expect(idsOf(groups)).toEqual([['spec', ['HIVE-1', 'HIVE-2']]]);
});
