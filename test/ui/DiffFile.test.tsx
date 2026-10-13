import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DiffFile } from '@/components/DiffFile';
import type { ReviewPane } from '@/components/review-context';
import { setLanguage } from '@/i18n';
import { EMPTY_REVIEW } from '@/lib/review-view';
import type { FileDiff } from '../../src/types';
import { jsonResponse } from '../fakes';
import { inSessionsPane } from './diff-harness';

const FILE: FileDiff = { path: 'src/a.ts', status: 'modified', hash: 'a'.repeat(64), hunks: [{ header: '@@ -1,2 +1,2 @@ intro', lines: [
  { kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: '2', new: 2 },
] }] };
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }));
beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const PANE: ReviewPane = { taskId: 'I1', scope: 'worktree', task: '#1 Task 1', review: EMPTY_REVIEW, sessions: [], defaultSession: 'new', refresh: vi.fn(), edit: vi.fn(), isSending: false, track: (request) => request };
const LINES = { isDragging: false, select: vi.fn(), begin: vi.fn(), extend: vi.fn(), comment: vi.fn(), close: vi.fn() };
const cells = (row: HTMLElement): string[] => within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
const section = (): HTMLElement => screen.getByRole('region', { name: 'src/a.ts' });

test('a unified section: header with path, counts and abrir arquivo, the hunk header, numbered lines; abrir arquivo opens the file at its top in the editor pane (#591, #717)', async () => {
  const openFile = vi.fn();
  render(inSessionsPane(PANE, <DiffFile file={FILE} id="f1" layout="unified" collapsed={false} isReviewed={false} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />, openFile));
  expect(section()).toHaveTextContent('src/a.ts+1 −1');
  const rows = within(section()).getAllByRole('row');
  expect(rows.map(cells)).toEqual([['intro'], ['1', '1', ' ', 'one'], ['2', '', '-', 'two'], ['', '2', '+', '2']]);
  await userEvent.setup().click(screen.getByRole('button', { name: 'abrir arquivo' }));
  expect(openFile).toHaveBeenCalledWith('src/a.ts');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('side by side pairs the deleted and added lines on one row; collapsed shows the header only; a deleted file has no abrir arquivo (#591)', async () => {
  const onToggle = vi.fn();
  const { rerender } = render(inSessionsPane(PANE, <DiffFile file={FILE} id="f1" layout="split" collapsed={false} isReviewed={false} onToggle={onToggle} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />));
  expect(within(section()).getAllByRole('row').map(cells)).toEqual([['intro'], ['1', ' ', 'one', '1', ' ', 'one'], ['2', '-', 'two', '2', '+', '2']]);
  await userEvent.setup().click(screen.getByRole('button', { name: 'recolher arquivo' }));
  expect(onToggle).toHaveBeenCalledOnce();
  rerender(inSessionsPane(PANE, <DiffFile file={{ ...FILE, status: 'deleted' }} id="f1" layout="split" collapsed isReviewed={false} onToggle={onToggle} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />));
  expect(within(section()).queryAllByRole('row')).toEqual([]);
  expect(screen.getByRole('button', { name: 'expandir arquivo' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'abrir arquivo' })).toBeNull();
});

const renderFile = (layout: 'unified' | 'split') =>
  render(inSessionsPane(PANE, <DiffFile file={FILE} id="f1" layout={layout} collapsed={false} isReviewed={false} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />));
// A col has no role; its width class is what fixes the code's x across files
const colWidths = (): string[] => Array.from(section().querySelectorAll('col'), (col) => col.className);

test('lines sit in a fixed-layout table: numbers 44px, sign 18px, so every file\'s code starts at the same x (#591)', () => {
  renderFile('unified');
  expect(section().querySelector('table')).toHaveClass('table-fixed');
  expect(colWidths()).toEqual(['w-11', 'w-11', 'w-[18px]', '']);
  cleanup();
  renderFile('split');
  expect(colWidths()).toEqual(['w-11', 'w-[18px]', '', 'w-11', 'w-[18px]', '']);
});

test('the gutter takes the status token at 30%, the body at 12%, numbers foreground, the sign in full colour; context stays bare (#591)', () => {
  renderFile('unified');
  const [, context, del, add] = within(section()).getAllByRole('row').map((row) => within(row).getAllByRole('cell'));
  for (const cell of context) expect(cell.className).not.toMatch(/bg-/);
  expect(context[0]).toHaveClass('text-empty');
  expect(del[0]).toHaveClass('bg-destructive/30', 'text-foreground');
  expect(del[1]).toHaveClass('bg-destructive/30', 'text-foreground');
  expect(del[2]).toHaveClass('bg-destructive/12', 'text-destructive');
  expect(del[3]).toHaveClass('bg-destructive/12');
  expect(add[0]).toHaveClass('bg-working/30', 'text-foreground');
  expect(add[2]).toHaveClass('bg-working/12', 'text-working');
  expect(add[3]).toHaveClass('bg-working/12');
});

test('side by side, each half takes the same gutter and body strengths (#591)', () => {
  renderFile('split');
  const paired = within(within(section()).getAllByRole('row')[2]).getAllByRole('cell');
  expect(paired[0]).toHaveClass('bg-destructive/30', 'text-foreground');
  expect(paired[1]).toHaveClass('bg-destructive/12', 'text-destructive');
  expect(paired[2]).toHaveClass('bg-destructive/12');
  expect(paired[3]).toHaveClass('bg-working/30', 'text-foreground');
  expect(paired[4]).toHaveClass('bg-working/12', 'text-working');
  expect(paired[5]).toHaveClass('bg-working/12');
});

// Where the + sits: the cell it lives in and its offset, the same for every line kind (#591)
const pluses = () => within(section()).getAllByRole('button', { name: /^comentar/ }).map((b) => ({ cell: b.closest('td'), className: b.className }));

test('unified, every line\'s + sits in the new number cell, centred on the gutter\'s border with the body, where the tint changes (#591)', () => {
  renderFile('unified');
  const rows = within(section()).getAllByRole('row').slice(1);
  const found = pluses();
  expect(found.map((p) => p.cell)).toEqual(rows.map((row) => within(row).getAllByRole('cell')[1]));
  for (const { className } of found) expect(className.split(' ')).toEqual(expect.arrayContaining(['absolute', 'right-0', 'translate-x-1/2', 'z-[1]']));
  expect(new Set(found.map((p) => p.className)).size).toBe(1);
});

test('side by side, each half\'s + sits in its number cell at the same place on every line (#591)', () => {
  renderFile('split');
  const rows = within(section()).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell'));
  const found = pluses();
  expect(found.map((p) => p.cell)).toEqual([rows[0][3], rows[1][0], rows[1][3]]);
  expect(new Set(found.map((p) => p.className)).size).toBe(1);
  expect(found[0].className.split(' ')).toEqual(expect.arrayContaining(['right-0', 'translate-x-1/2']));
});

test('the hunk header shows the function context on an 8% ring tint, the raw range in its title; lines 22px, numbers 11px with a 10px right pad (#853)', () => {
  renderFile('unified');
  const [head, line] = within(section()).getAllByRole('row').map((row) => within(row).getAllByRole('cell'));
  expect(head[0].textContent).toBe('intro');
  expect(head[0]).toHaveAttribute('title', '@@ -1,2 +1,2 @@ intro');
  expect(head[0]).toHaveClass('bg-ring/8', 'px-3.5', 'py-1', 'text-muted-foreground');
  expect(section().querySelector('table')).toHaveClass('leading-[22px]');
  expect(line[0]).toHaveClass('text-[11px]', 'pr-2.5');
});

test('a hunk with no function context keeps its @@ range (#853)', () => {
  const bare: FileDiff = { ...FILE, hunks: [{ ...FILE.hunks[0], header: '@@ -1,2 +1,2 @@' }] };
  render(inSessionsPane(PANE, <DiffFile file={bare} id="f1" layout="unified" collapsed={false} isReviewed={false} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />));
  expect(within(section()).getAllByRole('row').map(cells)[0]).toEqual(['@@ -1,2 +1,2 @@']);
});

const headerOf = (path: string): HTMLElement => screen.getByRole('region', { name: path }).querySelector('header') as HTMLElement;

test('the card: 1px border, radius 8px; a 40px card header with the folder muted, the name semibold, 12px counts and abrir arquivo in ring (#853)', () => {
  renderFile('unified');
  expect(section()).toHaveClass('rounded-lg', 'border', 'overflow-clip');
  const header = headerOf('src/a.ts');
  expect(header).toHaveClass('h-10', 'bg-card', 'px-3.5', 'border-b');
  expect(within(header).getByText('src/')).toHaveClass('text-muted-foreground');
  expect(within(header).getByText('a.ts')).toHaveClass('font-semibold');
  expect(within(header).getByText('+1').parentElement).toHaveClass('text-xs', 'tabular-nums');
  expect(within(header).getByRole('button', { name: 'abrir arquivo' })).toHaveClass('text-ring');
});

test('revisado is an outline button holding a check square, empty while unreviewed and filled with ✓ once reviewed; aria-pressed follows (#853)', () => {
  const ui = (isReviewed: boolean) => inSessionsPane(PANE, <DiffFile file={FILE} id="f1" layout="unified" collapsed={false} isReviewed={isReviewed} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />);
  const { rerender } = render(ui(false));
  const button = (): HTMLElement => screen.getByRole('button', { name: 'revisado' });
  const check = (): Element | null => button().querySelector('[data-slot="reviewed-check"]');
  expect(button()).toHaveAttribute('aria-pressed', 'false');
  expect(check()?.textContent).toBe('');
  expect(check()).toHaveClass('border-empty');
  rerender(ui(true));
  expect(button()).toHaveAttribute('aria-pressed', 'true');
  expect(check()?.textContent).toBe('✓');
  expect(check()).toHaveClass('bg-muted-foreground');
});

test('a collapsed card is its header alone, with no border under it; a rename keeps old → new whole (#853)', () => {
  const renamed: FileDiff = { ...FILE, path: 'src/b.ts', oldPath: 'src/a.ts', status: 'renamed' };
  render(inSessionsPane(PANE, <DiffFile file={renamed} id="f1" layout="unified" collapsed isReviewed={false} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />));
  expect(headerOf('src/b.ts')).not.toHaveClass('border-b');
  expect(within(screen.getByRole('region', { name: 'src/b.ts' })).queryAllByRole('row')).toEqual([]);
  expect(screen.getByText('src/a.ts → src/b.ts')).toBeInTheDocument();
});
