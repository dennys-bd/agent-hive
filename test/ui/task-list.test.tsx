import { expect, test } from 'vitest';
import { DISPLAY_DEFAULTS, type DisplayOptions } from '@/lib/flow-view';
import { LIST_PAGE, type ListGroup, type ListRow, listGroups, pageCut } from '@/lib/task-list';
import { flatten } from '../../src/flows';
import type { Flow, Item, Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// The list view's pure part (#577): two flows with tasks and docs with none, in config order
const stage = (name: string): Stage => ({ name, from: {}, prompt: '/hive-build {url}' });
const FLOWS: Flow[] = [
  { name: 'feature', stages: [stage('spec'), stage('build')], transitions: [] },
  { name: 'bug', stages: [stage('triage')], transitions: [] },
  { name: 'docs', stages: [stage('write')], transitions: [] },
];
const task = (id: string, at?: string, item: Partial<Item> = {}, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...item }, ...(at === undefined ? {} : { stage: at }), boardColumn: 'Ready', auto: true, ...extra,
});
const state = (tasks: WithWork[], workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], flows: FLOWS, ...flatten(FLOWS), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const display = (patch: Partial<DisplayOptions> = {}): DisplayOptions => ({ ...DISPLAY_DEFAULTS, ...patch });
const FLAT = display({ tree: false });
const shape = (groups: ListGroup[]): Array<[string, string[]]> => groups.map((g) => [g.key, g.rows.map((r) => `${r.task.item.id}:${r.depth}`)]);

test('one group per flow in config order and sem fluxo last, with the stageless task and one in a stage of no flow; a flow with no task has none; rows by stage index, then the Hive\'s order (#577 decisions 2, 5)', () => {
  const s = state([task('1', 'build'), task('2'), task('3', 'triage'), task('4', 'spec'), task('5', 'build'), task('6', 'gone')]);
  expect(shape(listGroups(s, FLAT, ''))).toEqual([['feature', ['4:0', '1:0', '5:0']], ['bug', ['3:0']], ['', ['2:0', '6:0']]]);
  expect(listGroups(s, FLAT, '').map((g) => g.flow?.name)).toEqual(['feature', 'bug', undefined]);
});

test('an unchecked source, a hidden epic and the search take rows out; a group left with none goes (#577 decision 1)', () => {
  const s = state([task('1', 'spec', { source: 'roadmap' }), task('2', 'spec'), task('3', 'triage', { title: 'Fix login' })]);
  expect(shape(listGroups(s, display({ tree: false, sourcesOff: ['roadmap'] }), ''))).toEqual([['feature', ['2:0']], ['bug', ['3:0']]]);
  expect(shape(listGroups(s, FLAT, 'LOGIN'))).toEqual([['bug', ['3:0']]]);
  const epics = state([task('1', 'spec', { children: ['I2'] }), task('2', 'spec', { parent: 'I1' }), task('3', 'spec')]);
  expect(shape(listGroups(epics, display({ tree: false, epics: 'all' }), ''))).toEqual([['feature', ['2:0', '3:0']]]);
});

test('with the tree on, a tree comes first where its root sat, children by depth, loose tasks after; a child in another flow sits in that flow\'s group; an epic counts its direct children done against its own flow\'s last stage as the card does; off, flat and uncounted (#577 decision 6, #723)', () => {
  const s = state([
    task('9', 'build'), task('1', 'build', { children: ['I2', 'I3', 'I8'], closedChildren: ['I8'] }),
    task('2', 'spec', { parent: 'I1', children: ['I4'] }), task('3', 'build', { parent: 'I1' }), task('4', 'triage', { parent: 'I2' }),
  ]);
  const groups = listGroups(s, display(), ''); // tree unset: on, as a tree exists
  expect(shape(groups)).toEqual([['feature', ['1:0', '2:1', '3:1', '9:0']], ['bug', ['4:2']]]);
  expect(groups[0].rows.map((r) => [r.tree, r.children])).toEqual([['I1', { done: 2, total: 3 }], ['I1', { done: 0, total: 1 }], ['I1', undefined], [undefined, undefined]]);
  expect(shape(listGroups(s, FLAT, ''))).toEqual([['feature', ['2:0', '9:0', '1:0', '3:0']], ['bug', ['4:0']]]);
  expect(listGroups(s, FLAT, '')[0].rows.every((r) => r.tree === undefined && r.children === undefined)).toBe(true);
});

test('needsYou counts the group\'s tasks waiting for you or for an approval, never one at work or new (#577 decision 3)', () => {
  const workers: Worker[] = [
    { id: 's1', status: 'waiting', activityId: activityIdOf('I1'), runId: 'W1' },
    { id: 's3', status: 'working', activityId: activityIdOf('I3'), runId: 'W3' },
  ];
  const s = state([task('1', 'spec'), task('2', 'build', {}, { approval: { since: '2026-11-05T10:00:00.000Z' } }), task('3', 'spec'), task('4')], workers);
  expect(listGroups(s, FLAT, '').map((g) => [g.key, g.needsYou])).toEqual([['feature', 2], ['', 0]]);
});

const rowsOf = (trees: Array<string | undefined>): ListRow[] =>
  trees.map((tree, i) => ({ task: task(String(i)), depth: tree === undefined ? 0 : 1, ...(tree === undefined ? {} : { tree }) }));
const loose = (n: number): undefined[] => Array.from({ length: n }, () => undefined);
const treeOf = (root: string, n: number): string[] => Array.from({ length: n }, () => root);

test('pageCut ends a page at LIST_PAGE rows or at the end of a shorter list, and past the end of a tree the cut would split, never into the next tree (#577 decision 7)', () => {
  expect(LIST_PAGE).toBe(25);
  expect([pageCut(rowsOf(loose(30)), LIST_PAGE), pageCut(rowsOf(loose(30)), 50), pageCut(rowsOf(loose(3)), LIST_PAGE)]).toEqual([25, 30, 3]);
  expect(pageCut(rowsOf([...loose(23), ...treeOf('B', 4), ...loose(3)]), LIST_PAGE)).toBe(27);
  expect(pageCut(rowsOf([...loose(21), ...treeOf('C', 4), ...loose(5)]), LIST_PAGE)).toBe(25);
  expect(pageCut(rowsOf([...loose(23), ...treeOf('B', 3), ...treeOf('D', 4)]), LIST_PAGE)).toBe(26);
  expect(pageCut(rowsOf(treeOf('E', 30)), LIST_PAGE)).toBe(30);
});
