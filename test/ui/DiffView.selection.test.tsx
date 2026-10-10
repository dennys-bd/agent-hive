import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import type { FileDiff } from '../../src/types';
import { activityOf, fakeHive, type FakeHive, LABEL, renderPane, withSessions } from './diff-harness';

// Two deleted lines against one added: side by side, the second deleted line's row has no new line
const FILE: FileDiff = { path: 'src/a.ts', status: 'modified', hash: 'a'.repeat(64), hunks: [{ header: '@@ -1,4 +1,3 @@', lines: [
  { kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'del', text: 'three', old: 3 },
  { kind: 'add', text: '2', new: 2 }, { kind: 'context', text: 'four', old: 4, new: 3 },
] }] };

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); hive.diff = { ...hive.diff, files: [FILE] }; });
afterEach(() => vi.unstubAllGlobals());
const lineRows = async (): Promise<HTMLElement[]> =>
  within(await within(screen.getByRole('region', { name: LABEL })).findByRole('region', { name: 'src/a.ts' })).getAllByRole('row').slice(1);
const cellsOf = (row: HTMLElement): HTMLElement[] => within(row).getAllByRole('cell');
// The selection bar has no role: it is marked by its data-slot, in a number cell like the +; unified, the new one, beside the body
const hasBar = (cell: HTMLElement): boolean => cell.querySelector('[data-slot="selection-bar"]') !== null;
const isShown = (button: HTMLElement): boolean => button.className.split(' ').includes('visible');

test('the start line shows only the +; the bar runs from the next selected line to the last (#591)', async () => {
  renderPane(activityOf(withSessions()));
  const rows = await lineRows();
  fireEvent.pointerDown(within(rows[0]).getByRole('button', { name: 'comentar linha 1' }));
  fireEvent.pointerEnter(rows[2]);
  expect(rows.map((row) => hasBar(cellsOf(row)[1]))).toEqual([false, true, true, false, false]);
  fireEvent.pointerUp(window);
  expect(rows.map((row) => hasBar(cellsOf(row)[1]))).toEqual([false, true, true, false, false]);
});

test('a drag upward keeps the + on its start line and bars the lines above it; one line shows only the + (#591)', async () => {
  renderPane(activityOf(withSessions()));
  const rows = await lineRows();
  fireEvent.pointerDown(within(rows[3]).getByRole('button', { name: 'comentar linha 2' }));
  fireEvent.pointerEnter(rows[1]);
  expect(rows.map((row) => hasBar(cellsOf(row)[1]))).toEqual([false, true, true, false, false]);
  expect(isShown(within(rows[3]).getByRole('button', { name: 'comentar linha 2' }))).toBe(true);
  fireEvent.pointerEnter(rows[3]);
  expect(rows.some((row) => hasBar(cellsOf(row)[1]))).toBe(false);
});

test('the + stays on the start line while the box is open and goes when the comment ends (#591)', async () => {
  const user = userEvent.setup();
  renderPane(activityOf(withSessions()));
  const rows = await lineRows();
  const plus = within(rows[0]).getByRole('button', { name: 'comentar linha 1' });
  fireEvent.pointerDown(plus);
  fireEvent.pointerEnter(rows[2]);
  fireEvent.pointerUp(window);
  const box = await screen.findByRole('group', { name: 'linha 1' }); // the new side: the deleted lines carry no new number
  expect(isShown(plus)).toBe(true);
  expect(isShown(within(rows[2]).getByRole('button', { name: 'comentar linha 3 (antiga)' }))).toBe(false);
  await user.type(within(box).getByRole('textbox'), '{Escape}');
  expect(isShown(plus)).toBe(false);
});

// Side by side, a row's cells: the old half's number, sign and code, then the new half's
const halfBars = (rows: HTMLElement[], half: 0 | 3): boolean[] => rows.map((row) => hasBar(cellsOf(row)[half]));

test('side by side, a drag from the old + bars only the old half, across its lines and down to the last one (#591)', async () => {
  localStorage.setItem('hive.diffLayout', 'split');
  renderPane(activityOf(withSessions()));
  const rows = await lineRows();
  fireEvent.pointerDown(within(rows[1]).getByRole('button', { name: 'comentar linha 2 (antiga)' }));
  fireEvent.pointerEnter(cellsOf(rows[3])[0]);
  fireEvent.pointerEnter(cellsOf(rows[1])[3]); // the added line is the other side's: the selection stays on its own
  expect(halfBars(rows, 0)).toEqual([false, false, true, true]);
  expect(halfBars(rows, 3)).toEqual([false, false, false, false]);
  fireEvent.pointerUp(window);
  expect(await screen.findByRole('group', { name: 'linhas 2–4' })).toBeInTheDocument(); // the old side's numbers
});

test('side by side, a drag from the new + bars only the new half, through the row where it has no line (#591)', async () => {
  localStorage.setItem('hive.diffLayout', 'split');
  renderPane(activityOf(withSessions()));
  const rows = await lineRows();
  fireEvent.pointerDown(within(rows[1]).getByRole('button', { name: 'comentar linha 2' }));
  fireEvent.pointerEnter(cellsOf(rows[2])[0]); // the deleted line is the other side's
  fireEvent.pointerEnter(cellsOf(rows[3])[3]);
  expect(halfBars(rows, 3)).toEqual([false, false, true, true]);
  expect(halfBars(rows, 0)).toEqual([false, false, false, false]);
  fireEvent.pointerUp(window);
  expect(await screen.findByRole('group', { name: 'linhas 2–3' })).toBeInTheDocument();
});
