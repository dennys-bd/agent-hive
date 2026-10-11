import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readView, resetViewState } from '@/lib/view-state';
import type { ProjectView } from '../../src/types';
import { ALL, fetchMock, heads, numbers, jsonRes, openMenu, renderTable, resetProjectTest, row, rowOf, VIEW } from './project-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

beforeEach(resetProjectTest);
afterEach(() => vi.unstubAllGlobals());

// Addendum 2: every field kind as a column, and the issue's own dates
const EVERY: ProjectView = {
  ...VIEW,
  fields: [...VIEW.fields, { name: 'Milestone', type: 'milestone' }, { name: 'Type', type: 'issueType' }, { name: 'Reviewers', type: 'other' }],
  items: [
    { ...VIEW.items[0], fields: { ...VIEW.items[0].fields, Milestone: 'v1', Type: 'Bug' }, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-05T10:00:00Z' },
    row(3, { closedAt: '2026-10-04T10:00:00Z' }),
  ],
};
const answerEvery = async (input: RequestInfo | URL): Promise<Response> => jsonRes(String(input).endsWith('/project') ? EVERY : { ok: true });

test('every new kind and the issue\'s dates are listed in the columns menu, hidden with nothing saved; shown, each renders its value, — when an unknown kind has none (#756)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(answerEvery);
  resetViewState();
  renderTable();
  await screen.findByText('2 issues · 1 no fluxo');
  expect(heads()).toEqual(['issue', 'status', 'Priority', 'labels', 'resp.', 'Target', 'Progress', 'PR', '']);
  await openMenu(user, /^colunas/);
  const added = ['Milestone', 'Type', 'Reviewers', 'criada', 'atualizada', 'fechada'];
  const items = screen.getAllByRole('menuitemcheckbox').map((i) => [i.textContent, i.getAttribute('aria-checked')]);
  expect(items.slice(-7)).toEqual([...added.map((name) => [`${name}project`, 'false']), ['PRhive', 'true']]);
  for (const name of added) await user.click(screen.getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) }));
  await user.keyboard('{Escape}');
  expect(heads()).toEqual(['issue', 'status', 'Priority', 'labels', 'resp.', 'Target', 'Progress', ...added, 'PR', '']);
  const twelve = within(rowOf('#12'));
  expect(twelve.getByText('v1')).toBeInTheDocument();
  expect(twelve.getByText('Bug')).toBeInTheDocument();
  expect(twelve.getByText('01/10')).toBeInTheDocument();
  expect(twelve.getByText('05/10')).toBeInTheDocument();
  expect(within(rowOf('#3')).getByText('04/10')).toBeInTheDocument();
  expect(within(rowOf('#3')).getAllByText('—')).toHaveLength(3); // no status, Reviewers (an issue has none) and PR; an empty milestone stays blank
});

test('a header sort is saved for the source and restored on reopening; nothing saved keeps the project\'s order (#756)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderTable();
  await screen.findByText('3 de 3');
  expect(numbers()).toEqual(['#12', '#3', '#40']);
  await user.click(screen.getByRole('button', { name: /^Estimate/ }));
  await user.click(screen.getByRole('button', { name: /^Estimate/ }));
  expect(readView('projectViews')).toEqual({ roadmap: { groupBy: null, collapsed: [], columns: ALL, sort: { key: 'field:Estimate', desc: true }, widths: {} } });
  unmount();
  renderTable();
  await screen.findByText('3 de 3');
  expect(numbers()).toEqual(['#40', '#12', '#3']);
  expect(screen.getByRole('columnheader', { name: /^Estimate/ })).toHaveAttribute('aria-sort', 'descending');
});

// The header's and a row's track of each column, issue first
const tracks = (): string[] => screen.getAllByRole('row')[0].style.gridTemplateColumns.split(' ');
const statusWidth = (): string | undefined => tracks()[1];
const handle = (name: string): HTMLElement => screen.getByRole('separator', { name: `redimensionar ${name}` });
const lines = (): string[] => [...screen.getByTestId('column-dividers').children].map((line) => (line as HTMLElement).style.right);

test('a handle sits on the left edge of each column, the action having none: dragging it right narrows that column within 40–480px, saved on release for the source; a double-click restores its default (#59)', async () => {
  const { unmount } = renderTable();
  await screen.findByText('3 de 3');
  expect(screen.getAllByRole('separator').map((h) => h.getAttribute('aria-label'))).toEqual([
    'redimensionar status', 'redimensionar Priority', 'redimensionar labels', 'redimensionar resp.', 'redimensionar Estimate',
    'redimensionar Target', 'redimensionar Progress', 'redimensionar Sprint', 'redimensionar PR',
  ]);
  expect(statusWidth()).toBe('128px');
  fireEvent.pointerDown(handle('status'), { pointerId: 1, clientX: 100 });
  fireEvent.pointerMove(handle('status'), { pointerId: 1, clientX: 150 });
  expect(statusWidth()).toBe('78px'); // the handoff's w0 - dx: the title takes up the 50px
  expect(rowOf('#12').style.gridTemplateColumns).toBe(tracks().join(' '));
  expect(readView('projectViews')).not.toEqual({ roadmap: expect.objectContaining({ widths: expect.objectContaining({ status: expect.any(Number) }) }) }); // saved once, on release
  fireEvent.pointerMove(handle('status'), { pointerId: 1, clientX: 2000 });
  expect(statusWidth()).toBe('40px');
  fireEvent.pointerMove(handle('status'), { pointerId: 1, clientX: -1000 });
  expect(statusWidth()).toBe('480px');
  fireEvent.pointerUp(handle('status'), { pointerId: 1, clientX: -1000 });
  fireEvent.pointerMove(handle('status'), { pointerId: 1, clientX: 100 }); // released: a move no longer resizes
  expect(statusWidth()).toBe('480px');
  expect(readView('projectViews')).toEqual({ roadmap: expect.objectContaining({ widths: { status: 480 } }) });
  unmount();
  renderTable();
  await screen.findByText('3 de 3');
  expect(statusWidth()).toBe('480px');
  fireEvent.doubleClick(handle('status'));
  expect(statusWidth()).toBe('128px');
  expect(readView('projectViews')).toEqual({ roadmap: expect.objectContaining({ widths: {} }) });
});

test('the handoff\'s defaults; the handles and the body dividers sit at the same right offsets; the table is at least as wide as its columns; no row, no body divider, the handles stay (#59)', async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText('3 de 3');
  expect(tracks()).toEqual(['minmax(160px,1fr)', '128px', '64px', '136px', '56px', '72px', '72px', '56px', '88px', '104px', '76px']);
  expect(handle('status').style.right).toBe('978px'); // 18 + 9×12 + 852
  expect(handle('PR').style.right).toBe('210px'); // 18 + 12 + 104 + 76
  expect(lines()).toHaveLength(9);
  expect([lines()[0], lines()[8]]).toEqual(['978px', '210px']);
  expect(screen.getByRole('table').parentElement).toHaveStyle({ minWidth: '1156px' }); // 160 + 852 + 10×12 + 24
  await user.type(screen.getByRole('textbox', { name: 'buscar tarefas' }), 'nada');
  expect(screen.getByText('0 de 3')).toBeInTheDocument();
  expect(screen.queryByTestId('column-dividers')).not.toBeInTheDocument();
  expect(screen.getAllByRole('separator')).toHaveLength(9);
});

test('a saved width out of 40–480px is drawn clamped (#756)', async () => {
  resetViewState({ projectViews: { roadmap: { groupBy: null, collapsed: [], columns: ['status'], sort: null, widths: { status: 5000 } } } });
  renderTable();
  await screen.findByText('3 de 3');
  expect(statusWidth()).toBe('480px');
});
