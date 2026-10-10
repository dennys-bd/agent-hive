import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DiffFile } from '@/components/DiffFile';
import type { ReviewPane } from '@/components/review-context';
import { setLanguage } from '@/i18n';
import { EMPTY_REVIEW } from '@/lib/review-view';
import type { FileDiff, ReviewAnchor, ReviewThread } from '../../src/types';
import { jsonResponse } from '../fakes';
import { inSessionsPane } from './diff-harness';

// What shows under a line (#591): the box and the conversations, in the half of their anchor side by side
const FILE: FileDiff = { path: 'src/a.ts', status: 'modified', hash: 'a'.repeat(64), hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [
  { kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: '2', new: 2 },
] }] };
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const PANE: ReviewPane = { taskId: 'I1', scope: 'worktree', task: '#1 Task 1', review: EMPTY_REVIEW, sessions: [], defaultSession: 'new', refresh: vi.fn(), edit: vi.fn(), isSending: false, track: (request) => request };
const LINES = { isDragging: false, select: vi.fn(), begin: vi.fn(), extend: vi.fn(), comment: vi.fn(), close: vi.fn() };
const anchor = (side: 'old' | 'new', n: number, text: string): ReviewAnchor => ({ scope: 'worktree', path: 'src/a.ts', side, start: n, end: n, excerpt: [text] });
const thread = (at: ReviewAnchor): ReviewThread => ({ id: 'T1', anchor: at, participants: [], messages: [{ id: 'M1', author: 'user', at: '2026-09-30T10:00:00Z', text: 'hi' }] });

function renderBox(layout: 'unified' | 'split', at: ReviewAnchor) {
  render(inSessionsPane(PANE, <DiffFile file={FILE} id="f1" layout={layout} collapsed={false} isReviewed={false} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} target={{ anchor: at }} onCloseBox={vi.fn()} />));
  return screen.getByRole('group', { name: `linha ${at.end}` });
}
function renderThread(layout: 'unified' | 'split', at: ReviewAnchor) {
  const pane = { ...PANE, review: { ...EMPTY_REVIEW, threads: [thread(at)] } };
  render(inSessionsPane(pane, <DiffFile file={FILE} id="f1" layout={layout} collapsed={false} isReviewed={false} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />));
  return screen.getByRole('group', { name: 'conversa' });
}
// The row a box or a conversation sits in, its cells, and the one holding it
const placeOf = (node: HTMLElement) => {
  const cell = node.closest('td') as HTMLTableCellElement;
  const cells = Array.from((cell.parentElement as HTMLTableRowElement).cells);
  return { cell, cells, at: cells.indexOf(cell) };
};
const isEmptyHalf = (cell?: HTMLTableCellElement): boolean => cell?.colSpan === 3 && cell.textContent === '';

test('side by side, a box on the new side sits in the right half, the left half\'s cell empty (#591)', () => {
  const { cells, at } = placeOf(renderBox('split', anchor('new', 2, '2')));
  expect(isEmptyHalf(cells[0])).toBe(true);
  expect(at).toBeGreaterThan(0);
});

test('side by side, a box on the old side sits in the left half, the right half\'s cell empty (#591)', () => {
  const { cells, at } = placeOf(renderBox('split', anchor('old', 2, 'two')));
  expect(isEmptyHalf(cells.at(-1))).toBe(true);
  expect(at).toBeLessThan(cells.length - 1);
});

test('side by side, a conversation takes its anchor\'s half, a context line\'s included (#591)', () => {
  const left = placeOf(renderThread('split', anchor('old', 2, 'two')));
  expect(isEmptyHalf(left.cells.at(-1))).toBe(true);
  document.body.innerHTML = '';
  const right = placeOf(renderThread('split', anchor('new', 1, 'one')));
  expect(isEmptyHalf(right.cells[0])).toBe(true);
  document.body.innerHTML = '';
  const oldContext = placeOf(renderThread('split', anchor('old', 1, 'one')));
  expect(isEmptyHalf(oldContext.cells.at(-1))).toBe(true);
});

// The row under a line takes that line's colours (#591): its gutter part the gutter's 30%, its body part the body's 12%
const tints = (cells: HTMLTableCellElement[]): string[] => cells.map((cell) => cell.className.split(' ').filter((c) => c.startsWith('bg-')).join(' '));

test('unified, the box\'s row takes the tints of the line above it: deleted, added, and none under context (#591)', () => {
  expect(tints(placeOf(renderBox('unified', anchor('old', 2, 'two'))).cells)).toEqual(['bg-destructive/30', 'bg-destructive/12']);
  document.body.innerHTML = '';
  const { cells, at } = placeOf(renderBox('unified', anchor('new', 2, '2')));
  expect([tints(cells), cells[0].colSpan, at]).toEqual([['bg-working/30', 'bg-working/12'], 2, 1]);
  document.body.innerHTML = '';
  expect(tints(placeOf(renderThread('unified', anchor('new', 1, 'one'))).cells)).toEqual(['', '']);
});

test('side by side, the half holding the box or a conversation takes its line\'s tints, the empty half none (#591)', () => {
  expect(tints(placeOf(renderBox('split', anchor('new', 2, '2'))).cells)).toEqual(['', 'bg-working/30', 'bg-working/12']);
  document.body.innerHTML = '';
  expect(tints(placeOf(renderThread('split', anchor('old', 2, 'two'))).cells)).toEqual(['bg-destructive/30', 'bg-destructive/12', '']);
});
