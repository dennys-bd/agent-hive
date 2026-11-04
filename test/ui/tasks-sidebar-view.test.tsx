import { afterEach, expect, test } from 'vitest';
import { SECTION_MAX, SECTION_MIN, SIDEBAR_DEFAULTS, clampHeight, entryCounts, lastOpen, readTasksSidebar, withResize, withToggle, writeTasksSidebar } from '@/lib/tasks-sidebar';
import { readView, resetViewState } from '@/lib/view-state';
import { SIDEBAR_STATE } from './sidebar-fixtures.js';

const ALL_OPEN = { automation: false, tasks: false, sources: false, repos: false };
const stored = (value: unknown) => {
  resetViewState({ tasksSidebar: value });
  return readTasksSidebar();
};
afterEach(() => resetViewState()); // also drops writeTasksSidebar's pending post

test('nothing stored, or no plain object, reads as the defaults: every section open, 200 / 150 / 200 / 240 (#572)', () => {
  resetViewState();
  expect(readTasksSidebar()).toEqual({ closed: ALL_OPEN, heights: { automation: 200, tasks: 150, sources: 200, repos: 240 } });
  for (const value of [null, 3, 'open', [ALL_OPEN]]) expect(stored(value)).toEqual(SIDEBAR_DEFAULTS);
});

test('each field is read on its own: a bad flag or height falls back alone, a height outside 60–560 is clamped (#572)', () => {
  const view = stored({ closed: { automation: true, tasks: 'yes' }, heights: { automation: 20, tasks: 900, sources: Number.NaN, repos: '240' } });
  expect(view).toEqual({ closed: { ...ALL_OPEN, automation: true }, heights: { automation: 60, tasks: 560, sources: 200, repos: 240 } });
  expect(stored({ closed: 'x', heights: [] })).toEqual(SIDEBAR_DEFAULTS);
  expect([clampHeight(SECTION_MIN - 1), clampHeight(300), clampHeight(SECTION_MAX + 1)]).toEqual([60, 300, 560]);
});

test('writeTasksSidebar puts the whole value under tasksSidebar and readTasksSidebar round-trips it (#572)', () => {
  resetViewState();
  const view = { closed: { ...ALL_OPEN, tasks: true }, heights: { automation: 120, tasks: 150, sources: 300, repos: 240 } };
  writeTasksSidebar(view);
  expect(readView('tasksSidebar')).toEqual(view);
  expect(readTasksSidebar()).toEqual(view);
});

test('lastOpen is the last section not closed, none when every one is (#572)', () => {
  const view = (closed: Partial<typeof ALL_OPEN>) => ({ ...SIDEBAR_DEFAULTS, closed: { ...ALL_OPEN, ...closed } });
  expect(lastOpen(view({}))).toBe('repos');
  expect(lastOpen(view({ repos: true, sources: true }))).toBe('tasks');
  expect(lastOpen(view({ automation: true, tasks: true, sources: true, repos: true }))).toBeUndefined();
});

test('withResize clamps and withToggle flips, each returning a new view and leaving its input as it was (#572)', () => {
  const before = structuredClone(SIDEBAR_DEFAULTS);
  const resized = withResize(SIDEBAR_DEFAULTS, 'tasks', 999);
  const toggled = withToggle(SIDEBAR_DEFAULTS, 'sources');
  expect(resized).toEqual({ ...before, heights: { ...before.heights, tasks: 560 } });
  expect(toggled).toEqual({ ...before, closed: { ...before.closed, sources: true } });
  expect(withToggle(toggled, 'sources')).toEqual(before);
  expect([resized === SIDEBAR_DEFAULTS, toggled === SIDEBAR_DEFAULTS]).toEqual([false, false]);
  expect(SIDEBAR_DEFAULTS).toEqual(before);
});

test('entryCounts: every task, each flow\'s, the ones in no flow; ● N counts waiting and approval only; sourcesOff is not read (#572)', () => {
  const expected = { all: { total: 5, needsYou: 3 }, flows: { build: { total: 1, needsYou: 1 }, ship: { total: 2, needsYou: 1 } }, outside: { total: 2, needsYou: 1 } };
  resetViewState();
  expect(entryCounts(SIDEBAR_STATE)).toEqual(expected);
  resetViewState({ flowView: { sourcesOff: ['roadmap', 'notes', 'hive'] } });
  expect(entryCounts(SIDEBAR_STATE)).toEqual(expected); // decision 10: the display options filter only the center
});
