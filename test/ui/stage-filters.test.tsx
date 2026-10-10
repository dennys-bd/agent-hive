import { expect, test } from 'vitest';
import { readStageFilters, rulesFor, visibleUnderFilter, withStageFilter, writeStageFilters } from '@/lib/stage-filters';
import { readView, resetViewState } from '@/lib/view-state';
import type { Task, FilterRule } from '../../src/types';

// The filters as the view state holds them under stageFilters (#484), read back through readStageFilters
const readStored = (value: unknown) => {
  resetViewState({ stageFilters: value });
  return readStageFilters();
};
const ANA: FilterRule = { field: 'assignee', op: 'any', values: ['ana'] };
const P1: FilterRule = { field: 'projectField', name: 'Priority', op: 'none', values: ['P1'] };
const task = (id: string, assignees?: string[]): Task => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...(assignees ? { facets: { assignees, labels: [], fields: {} } } : {}) },
  stage: 'dev', boardColumn: 'Ready', auto: true,
});
const ids = (tasks: Task[]): string[] => tasks.map((c) => c.item.id);

test('writeStageFilters puts each stage\'s rules in the view state\'s stageFilters, a stage with no rule left out, and readStageFilters round-trips them (#374, #484)', () => {
  resetViewState();
  writeStageFilters({ dev: [ANA, P1], review: [] });
  expect(readView('stageFilters')).toEqual({ dev: [ANA, P1] });
  expect(readStageFilters()).toEqual({ dev: [ANA, P1] });
});

test('readStageFilters: nothing saved, or a value that is no object, reads as no filter (#374, #484)', () => {
  resetViewState();
  expect(readStageFilters()).toEqual({});
  for (const value of [null, 3, 'dev', '{not json', [ANA]]) expect(readStored(value)).toEqual({});
});

test('readStageFilters drops, alone, a stage whose value is not a list of complete, well-formed rules (#374)', () => {
  const bad: unknown[] = [
    'x', [], [{ ...ANA, field: 'title' }], [{ ...ANA, op: 'all' }], [{ ...ANA, values: 'ana' }], [{ ...ANA, values: [1] }], [{ ...ANA, values: [] }],
    [{ ...ANA, name: 'Priority' }], [{ field: 'projectField', op: 'any', values: ['P1'] }], [{ ...P1, name: ' ' }], [ANA, null],
  ];
  const map = Object.fromEntries(bad.map((rules, i) => [`bad${i}`, rules]));
  expect(readStored({ ...map, dev: [ANA] })).toEqual({ dev: [ANA] });
});

test('withStageFilter replaces one stage\'s rules, clears it with [], and drops every stage the Hive no longer has, leaving its input as it was (#374)', () => {
  const before = { dev: [ANA], gone: [ANA] };
  expect(withStageFilter(before, 'review', [P1], ['dev', 'review'])).toEqual({ dev: [ANA], review: [P1] });
  expect(withStageFilter(before, 'dev', [], ['dev', 'review'])).toEqual({});
  expect(before).toEqual({ dev: [ANA], gone: [ANA] });
});

test('rulesFor reads own keys only; visibleUnderFilter keeps the passing tasks in their order, a task without facets failing any and passing none (#374)', () => {
  expect(rulesFor({ dev: [ANA] }, 'dev')).toEqual([ANA]);
  expect(rulesFor({}, 'constructor')).toEqual([]);
  const tasks = [task('1', ['Ana']), task('2', ['bia']), task('3')];
  expect(ids(visibleUnderFilter(tasks, [ANA]))).toEqual(['1']);
  expect(ids(visibleUnderFilter(tasks, [{ ...ANA, op: 'none' }]))).toEqual(['2', '3']);
  expect(visibleUnderFilter(tasks, [])).toEqual(tasks);
});

test('a stored blocked rule (#441) survives a read with no values; one carrying values or a name is dropped; visibleUnderFilter reads each task\'s open blockers, facets or not', () => {
  const FREE: FilterRule = { field: 'blocked', op: 'none' };
  expect(readStored({ dev: [FREE, ANA], bad0: [{ ...FREE, values: [] }], bad1: [{ ...FREE, name: 'x' }] })).toEqual({ dev: [FREE, ANA] });
  const blocked = (c: Task): Task => ({ ...c, item: { ...c.item, blockedBy: ['9'] } });
  const tasks = [task('1', ['ana']), blocked(task('2', ['ana'])), blocked(task('3')), task('4')];
  expect(ids(visibleUnderFilter(tasks, [FREE]))).toEqual(['1', '4']);
  expect(ids(visibleUnderFilter(tasks, [{ field: 'blocked', op: 'any' }]))).toEqual(['2', '3']);
  expect(ids(visibleUnderFilter(tasks, [FREE, ANA]))).toEqual(['1']);
});
