import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectTable } from '@/components/ProjectTable';
import { readView, resetViewState } from '@/lib/view-state';
import { flatten } from '../../src/flows';
import type { Flow, ProjectView, Stage, State, Task } from '../../src/types';
import { ALL, fetchMock, heads, numbers, jsonRes, openMenu, renderTable, resetProjectTest, row, rowOf, state, TASK, VIEW } from './project-harness';

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

test('a fresh source shows status, labels, every milestone and progress field and PR; the other kinds and the issue\'s dates are listed in the columns menu, hidden; shown, each renders its value, — when an unknown kind has none (#756, #583)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(answerEvery);
  resetViewState();
  renderTable();
  await screen.findByText('2 itens · 1 tarefas');
  expect(heads()).toEqual(['issue', 'status', 'labels', 'Progress', 'Milestone', 'PR', '']);
  await openMenu(user, /^colunas/);
  const added = ['Type', 'Reviewers', 'criada', 'atualizada', 'fechada'];
  const items = screen.getAllByRole('menuitemcheckbox').map((i) => [i.textContent, i.getAttribute('aria-checked')]);
  expect(items.slice(-8)).toEqual([['Milestoneproject', 'true'], ...added.map((name) => [`${name}project`, 'false']), ['bloqueada porproject', 'false'], ['PRhive', 'true']]);
  for (const name of added) await user.click(screen.getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) }));
  await user.keyboard('{Escape}');
  expect(heads()).toEqual(['issue', 'status', 'labels', 'Progress', 'Milestone', ...added, 'PR', '']);
  const twelve = within(rowOf('#12'));
  expect(twelve.getByText('v1')).toBeInTheDocument();
  expect(twelve.getByText('Bug')).toBeInTheDocument();
  expect(twelve.getByText('01/10')).toBeInTheDocument();
  expect(twelve.getByText('05/10')).toBeInTheDocument();
  expect(within(rowOf('#3')).getByText('04/10')).toBeInTheDocument();
  expect(within(rowOf('#3')).getAllByText('—')).toHaveLength(3); // no status, Reviewers (an issue has none) and no PR; an empty milestone stays blank
});

test('a header sort is saved for the source and restored on reopening; nothing saved keeps the project\'s order (#756)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderTable();
  await screen.findByText('3 de 3');
  expect(numbers()).toEqual(['#12', '#3', '#40']);
  await user.click(screen.getByRole('button', { name: /^Estimate/ }));
  await user.click(screen.getByRole('button', { name: /^Estimate/ }));
  expect(readView('projectViews')).toEqual({ roadmap: { groupBy: null, collapsed: [], columns: ALL, blockedByShown: true, sort: { key: 'field:Estimate', desc: true }, widths: {} } });
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
  expect(tracks()).toEqual(['minmax(160px,1fr)', '128px', '64px', '136px', '56px', '72px', '72px', '56px', '88px', '104px', '150px']);
  expect(handle('status').style.right).toBe('1052px'); // 18 + 9×12 + 926
  expect(handle('PR').style.right).toBe('284px'); // 18 + 12 + 104 + 150
  expect(lines()).toHaveLength(9);
  expect([lines()[0], lines()[8]]).toEqual(['1052px', '284px']);
  expect(screen.getByRole('table').parentElement).toHaveStyle({ minWidth: '1230px' }); // 160 + 926 + 10×12 + 24
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

// #583: build holds spec and dev, ship holds review. HIVE-1 is in review with a PR, HIVE-2 has no stage, HIVE-3 is in spec on site; TASK is roadmap's
const stage = (name: string): Stage => ({ name, from: {}, prompt: 'x' });
const FLOWS: Flow[] = [{ name: 'build', stages: [stage('spec'), stage('dev')], transitions: [] }, { name: 'ship', stages: [stage('review')], transitions: [] }];
const hiveTask = (n: number, at?: string, workspace?: string): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, ...(at === undefined ? {} : { stage: at }),
  ...(workspace === undefined ? {} : { workspace }), boardColumn: '', auto: false, created: true,
});
const hiveState = (): State => ({
  ...state([hiveTask(1, 'review'), hiveTask(2), hiveTask(3, 'spec', 'site'), TASK]), flows: FLOWS, ...flatten(FLOWS), workspaces: ['hive', 'site'],
  activityRecords: [{ id: 'A1', taskIds: ['local:1'], sessions: [], prs: [{ url: 'https://github.com/acme/r/pull/9', state: 'open' }] }],
});
const renderHive = (over: { onGoTo?: (taskId: string) => void; onOpenIssue?: () => void } = {}) =>
  render(<ProjectTable state={hiveState()} source="hive" onGoTo={over.onGoTo ?? vi.fn()} onOpenIssue={over.onOpenIssue ?? vi.fn()} />);
const hiveGroupTexts = (): (string | null)[] => screen.getAllByRole('row').filter((r) => r.closest('tbody') && r.children.length === 1).map((r) => r.textContent);

test('the hive table: hive · tarefas do hive · sem sync externo, the five fixed columns, no columns menu, grouped by stage in the flows\' order with sem fluxo last, read from the state alone (#583)', async () => {
  const user = userEvent.setup();
  resetViewState();
  renderHive();
  expect(screen.getByText('tarefas do hive · sem sync externo')).toBeInTheDocument();
  expect(heads()).toEqual(['issue', 'status', 'Workspace', 'PR', '']);
  expect(screen.getByText('3 itens · 3 tarefas')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^colunas/ })).not.toBeInTheDocument();
  expect(hiveGroupTexts()).toEqual(['spec1', 'review1', 'sem fluxo1']);
  expect(screen.getByText('células com ⌄ são editáveis · arraste as divisões para redimensionar · mudar o status move a tarefa para a etapa ligada a ele')).toBeInTheDocument();
  await openMenu(user, /^agrupar/);
  expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['nenhum', 'status']);
  expect(fetchMock).not.toHaveBeenCalled(); // decision 2: no GET /sources/hive/project
});

test('a hive row: the stage menu as its status, the Workspace as plain text, its PR, the task column; a click goes to its task, not to an issue page (#583)', async () => {
  const user = userEvent.setup();
  const onGoTo = vi.fn();
  const onOpenIssue = vi.fn();
  resetViewState();
  renderHive({ onGoTo, onOpenIssue });
  const three = within(rowOf('#HIVE-3'));
  expect(three.getByRole('button', { name: 'spec' })).toHaveAttribute('data-slot', 'field-cell');
  expect(within(three.getAllByRole('cell')[2]).getByText('site')).toBeInTheDocument();
  expect(three.queryByRole('button', { name: 'editar Workspace' })).not.toBeInTheDocument(); // decision 5: read-only
  expect(three.getByRole('button', { name: 'build · spec ›' })).toBeInTheDocument();
  expect(within(rowOf('#HIVE-1')).getByText('#9')).toHaveClass('text-review');
  expect(within(rowOf('#HIVE-2')).getByRole('button', { name: '—' })).toHaveAttribute('data-slot', 'field-cell');
  expect(within(rowOf('#HIVE-2')).getByRole('button', { name: 'sem fluxo ›' })).toBeInTheDocument();
  await user.click(within(rowOf('#HIVE-2')).getByText('Task 2'));
  expect(onGoTo).toHaveBeenCalledWith('local:2');
  expect(onOpenIssue).not.toHaveBeenCalled();
});
