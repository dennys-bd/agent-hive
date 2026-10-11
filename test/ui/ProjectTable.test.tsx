import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { readView, resetViewState } from '@/lib/view-state';
import type { ProjectItem, ProjectView, Task } from '../../src/types';
import { ALL, fetchMock, heads, jsonRes, numbers, openMenu, renderTable, resetProjectTest, row, rowOf, TASK, VIEW } from './project-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

beforeEach(resetProjectTest);
afterEach(() => vi.unstubAllGlobals());

test('the table reads the source\'s view on opening: issue first, status, labels and resp. at their project position among the field columns, PR then the action last, each value by its kind, the counts and the footer (#756)', async () => {
  renderTable();
  expect(await screen.findByText('3 issues · 1 no fluxo')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/sources/roadmap/project');
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['issue', 'status', 'Priority', 'labels', 'resp.', 'Estimate', 'Target', 'Progress', 'Sprint', 'PR', '']);
  const twelve = within(rowOf('#12'));
  expect(twelve.getByText('P2')).toBeInTheDocument();
  expect(twelve.getByText('5')).toHaveClass('text-right');
  expect(twelve.getByText('20/10')).toBeInTheDocument();
  expect(twelve.getByText('1/3')).toBeInTheDocument();
  expect(twelve.getByText('bug')).toBeInTheDocument();
  expect(twelve.getByText('AN')).toHaveAttribute('title', 'ana');
  expect(within(rowOf('#40')).getByText('#7')).toHaveClass('text-review'); // not a task: the PR that closes the issue
  expect(within(rowOf('#40')).getByText('✓')).toHaveClass('text-working');
  expect(twelve.getByText('—')).toBeInTheDocument(); // a task row shows the task's own PRs: none here
  expect(screen.getByText('3 de 3')).toBeInTheDocument();
  expect(screen.getByText('células com ⌄ são editáveis · arraste as divisões para redimensionar · ⇧↵ abre a issue')).toBeInTheDocument();
});

test('a header sorts by its column and again reverses; the project\'s own order is the default (#756)', async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText('3 de 3');
  expect(numbers()).toEqual(['#12', '#3', '#40']);
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  expect(numbers()).toEqual(['#3', '#12', '#40']);
  expect(screen.getByRole('columnheader', { name: /^issue/ })).toHaveAttribute('aria-sort', 'ascending');
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  expect(numbers()).toEqual(['#40', '#12', '#3']);
  await user.click(screen.getByRole('button', { name: /^Estimate/ }));
  expect(numbers()).toEqual(['#3', '#12', '#40']); // 1, 5, 13: as numbers, not text
  await user.click(screen.getByRole('button', { name: /^status/ }));
  expect(numbers()).toEqual(['#3', '#12', '#40']); // Todo, Ready, Done: the options' order
});

test('the search matches the title or #number, case-insensitive, and the footer counts what it leaves (#756)', async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText('3 de 3');
  const search = screen.getByRole('textbox', { name: 'buscar tarefas' });
  await user.type(search, 'ISSUE 4');
  expect(numbers()).toEqual(['#40']);
  expect(screen.getByText('1 de 3')).toBeInTheDocument();
  await user.clear(search);
  await user.type(search, '#3');
  expect(numbers()).toEqual(['#3']);
});

test('a click on any row opens its issue page; fluxo › still goes to the task; ⇧↵ on a focused row opens the issue on GitHub (#756, #757)', async () => {
  const user = userEvent.setup();
  const onGoTo = vi.fn();
  const onOpenIssue = vi.fn<(item: ProjectItem) => void>();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  renderTable({ onGoTo, onOpenIssue });
  await screen.findByText('3 de 3');
  await user.click(within(rowOf('#12')).getByRole('button', { name: 'fluxo ›' }));
  expect(onGoTo.mock.calls).toEqual([['roadmap:PVTI_12']]);
  await user.click(within(rowOf('#12')).getByText('Issue 12'));
  await user.click(within(rowOf('#40')).getByText('Issue 40'));
  expect(onOpenIssue.mock.calls.map(([item]) => item.itemId)).toEqual(['roadmap:PVTI_12', 'roadmap:PVTI_40']);
  expect(onGoTo).toHaveBeenCalledOnce();
  rowOf('#3').focus();
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(open).toHaveBeenCalledWith('https://github.com/acme/r/issues/3', '_blank', 'noreferrer');
  open.mockRestore();
});

test('lendo… while the view reads, and the subbar names the cap when the read stopped at it (#756)', async () => {
  let settle: (res: Response) => void = () => undefined;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { settle = resolve; }));
  renderTable();
  expect(screen.getByText('lendo…')).toBeInTheDocument();
  settle(jsonRes({ ...VIEW, truncated: true }));
  expect(await screen.findByText('3 issues · 1 no fluxo · primeiros 3')).toBeInTheDocument();
});

test('a refused read shows its reason in place of the table and as a toast; inside the quota backoff it names the reset time (#756)', async () => {
  fetchMock.mockImplementation(async () => jsonRes({ error: 'Bad credentials' }, 502));
  const { unmount } = renderTable();
  expect(await screen.findByText('Bad credentials')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(toast.error).toHaveBeenCalledWith('Bad credentials');
  unmount();
  fetchMock.mockImplementation(async () => jsonRes({ error: 'GitHub quota is low', resetsAt: new Date(2026, 9, 6, 14, 5).toISOString() }, 429));
  renderTable();
  expect(await screen.findByText('quota do GitHub baixa; tente depois de 14:05')).toBeInTheDocument();
});

test('fluxo… shows on an issue kept out that no task came from; confirming posts /tasks with its title, body, url, origin, auto off and the first stage, then goes to the new task (#756)', async () => {
  const user = userEvent.setup();
  const onGoTo = vi.fn();
  fetchMock.mockImplementation(async (input) => (String(input).endsWith('/project') ? jsonRes(VIEW) : jsonRes({ id: 'HIVE-1', itemId: 'local:1' }, 201)));
  renderTable({ onGoTo });
  await screen.findByText('3 de 3');
  expect(within(rowOf('#40')).queryByRole('button', { name: 'fluxo…' })).not.toBeInTheDocument(); // passes the filter: its way in is the Status
  await user.click(within(rowOf('#3')).getByRole('button', { name: 'fluxo…' }));
  expect(screen.getByText('criar tarefa no fluxo')).toBeInTheDocument();
  expect(screen.getByText('sem sync')).toHaveClass('text-foreground');
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(onGoTo).toHaveBeenCalledWith('local:1'));
  expect(fetchMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ title: 'Issue 3', body: 'body 3', stage: 'dev', auto: false, url: 'https://github.com/acme/r/issues/3', source: 'hive', origin: 'roadmap:PVTI_3' }),
  }));
});

test('an issue a Hive task was created from counts in the flow and shows fluxo › to that task, not fluxo… (#756)', async () => {
  const user = userEvent.setup();
  const onGoTo = vi.fn();
  const copy: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Issue 3', body: '', url: '', origin: 'roadmap:PVTI_3' }, stage: 'dev', boardColumn: '', auto: false, created: true };
  renderTable({ onGoTo, tasks: [TASK, copy] });
  expect(await screen.findByText('3 issues · 2 no fluxo')).toBeInTheDocument();
  expect(within(rowOf('#3')).queryByRole('button', { name: 'fluxo…' })).not.toBeInTheDocument();
  await user.click(within(rowOf('#3')).getByRole('button', { name: 'fluxo ›' }));
  expect(onGoTo).toHaveBeenCalledWith('local:1');
});

test('with nothing saved every column shows but the iteration and number fields, at the handoff\'s widths, under a header that stays as the body scrolls, in a box that fills the pane with no visible scrollbar (#756, #59)', async () => {
  resetViewState();
  renderTable();
  await screen.findByText('3 issues · 1 no fluxo');
  expect(heads()).toEqual(['issue', 'status', 'Priority', 'labels', 'resp.', 'Target', 'Progress', 'PR', '']);
  const head = screen.getAllByRole('row')[0];
  expect(head.style.gridTemplateColumns).toBe('minmax(160px,1fr) 128px 64px 136px 56px 72px 56px 104px 76px'); // Priority 64, date 72, progress 56
  expect(head.closest('thead')).toHaveClass('sticky');
  const scroller = screen.getByRole('table').parentElement?.parentElement;
  expect(scroller).toHaveClass('[scrollbar-width:none]');
  expect(scroller?.parentElement).toHaveClass('flex-1');
});

test('the columns menu lists every hideable column in project order with its origin, never issue nor action; a toggle shows or hides it and is saved for the source (#756)', async () => {
  const user = userEvent.setup();
  resetViewState();
  const { unmount } = renderTable();
  await screen.findByText('3 issues · 1 no fluxo');
  await openMenu(user, /^colunas/);
  const items = screen.getAllByRole('menuitemcheckbox');
  expect(items.map((i) => i.textContent)).toEqual([
    'statusproject', 'Priorityproject', 'labelsproject', 'resp.project', 'Estimateproject', 'Targetproject', 'Progressproject', 'Sprintproject',
    'criadaproject', 'atualizadaproject', 'fechadaproject', 'PRhive',
  ]);
  expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true', 'false', 'true', 'true', 'false', 'false', 'false', 'false', 'true']);
  expect(screen.getByText('os campos vêm do project. a ordem segue a do project.')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitemcheckbox', { name: /^Priority/ }));
  await user.click(screen.getByRole('menuitemcheckbox', { name: /^Estimate/ }));
  expect(screen.getByRole('menuitemcheckbox', { name: /^Estimate/ })).toHaveAttribute('aria-checked', 'true'); // the menu stays open
  await user.keyboard('{Escape}');
  expect(heads()).toEqual(['issue', 'status', 'labels', 'resp.', 'Estimate', 'Target', 'Progress', 'PR', '']);
  expect(readView('projectViews')).toEqual({ roadmap: expect.objectContaining({ columns: ['status', 'labels', 'assignee', 'field:Estimate', 'field:Target', 'field:Progress', 'pr'] }) });
  unmount();
  renderTable();
  await screen.findByText('3 issues · 1 no fluxo');
  expect(heads()).toEqual(['issue', 'status', 'labels', 'resp.', 'Estimate', 'Target', 'Progress', 'PR', '']);
});

// Blocked has no issue; #7 has no Status, two assignees and P0; #5 is a second Todo
const GROUPED: ProjectView = {
  ...VIEW, statuses: [{ name: 'Todo' }, { name: 'Blocked' }, { name: 'Ready', stage: 'dev' }, { name: 'Done' }],
  items: [...VIEW.items, row(7, { assignees: ['ana', 'bo'], fields: { Priority: 'P0' } }), row(5, { status: 'Todo' })],
};
const answerGrouped = async (input: RequestInfo | URL): Promise<Response> => jsonRes(String(input).endsWith('/project') ? GROUPED : { ok: true });
// A group row is the body's one-cell row: its button folds it
const groupRows = (): HTMLElement[] => screen.getAllByRole('row').filter((r) => r.closest('tbody') && r.children.length === 1);
const groups = (): (string | null)[] => groupRows().map((r) => r.textContent);
const group = (name: RegExp): HTMLElement => groupRows().map((r) => within(r).getByRole('button')).find((b) => name.test(b.textContent ?? ''))!;

test('with nothing saved the rows group by status in Status order with counts and stages, empty groups hidden, no status last, Done collapsed; a click toggles (#756)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(answerGrouped);
  resetViewState();
  renderTable();
  await screen.findByText('5 issues · 1 no fluxo');
  expect(groups()).toEqual(['Todo2sem etapa', 'Ready1→ dev', 'Done1sem etapa', 'sem status1']);
  expect(groupRows()[0]).toHaveClass('sticky', 'z-[5]', 'bg-card'); // opaque and above the overlay: a divider stops at it
  expect(group(/^Done/)).toHaveAttribute('aria-expanded', 'false');
  expect(numbers()).toEqual(['#3', '#5', '#12', '#7']);
  await user.click(group(/^Done/));
  expect(numbers()).toEqual(['#3', '#5', '#12', '#40', '#7']);
  await user.click(group(/^Todo/));
  expect(numbers()).toEqual(['#12', '#40', '#7']);
  expect(readView('projectViews')).toEqual({ roadmap: expect.objectContaining({ groupBy: 'status', collapsed: ['Todo'] }) });
  expect(screen.getByText('5 de 5')).toBeInTheDocument(); // a folded row still counts
});

test('a header sort applies inside each group (#756)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(answerGrouped);
  resetViewState({ projectViews: { roadmap: { groupBy: 'status', collapsed: [], columns: ALL } } });
  renderTable();
  await screen.findByText('5 de 5');
  expect(numbers()).toEqual(['#3', '#5', '#12', '#40', '#7']);
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  expect(numbers()).toEqual(['#5', '#3', '#12', '#40', '#7']);
});

test('the group menu offers none, status, the single-select fields, resp. and the iteration fields; a field groups in its options\' order, resp. by each combination; the choice is saved (#756)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(answerGrouped);
  resetViewState({ projectViews: { roadmap: { groupBy: 'status', collapsed: [], columns: ALL } } });
  renderTable();
  await screen.findByText('5 de 5');
  await openMenu(user, /^agrupar/);
  expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['nenhum', 'status', 'Priority', 'resp.', 'Sprint']);
  expect(screen.getByRole('menuitemradio', { name: 'status' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('campos single-select do project. fica salvo por source.')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitemradio', { name: 'Priority' }));
  expect(groups()).toEqual(['P02', 'P21', 'sem Priority2']); // P1 has no issue
  expect(numbers()).toEqual(['#3', '#7', '#12', '#40', '#5']);
  await openMenu(user, /^agrupar/);
  await user.click(screen.getByRole('menuitemradio', { name: 'resp.' }));
  expect(groups()).toEqual(['ana1', 'ana, bo1', 'sem resp.3']);
  expect(readView('projectViews')).toEqual({ roadmap: expect.objectContaining({ groupBy: 'assignee' }) });
  await openMenu(user, /^agrupar/);
  await user.click(screen.getByRole('menuitemradio', { name: 'nenhum' }));
  expect(groups()).toEqual([]);
  expect(numbers()).toEqual(['#12', '#3', '#40', '#7', '#5']);
});

test('hiding the sorted column drops the sort: the rows go back to the project\'s order (#756)', async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText('3 de 3');
  await user.click(screen.getByRole('button', { name: /^Estimate/ }));
  await user.click(screen.getByRole('button', { name: /^Estimate/ }));
  expect(numbers()).toEqual(['#40', '#12', '#3']);
  await openMenu(user, /^colunas/);
  await user.click(screen.getByRole('menuitemcheckbox', { name: /^Estimate/ }));
  await user.keyboard('{Escape}');
  expect(numbers()).toEqual(['#12', '#3', '#40']);
});

test('a field cell writes through its editor and the answer\'s row replaces its row, with no reload of the view (#686)', async () => {
  const user = userEvent.setup();
  const written: ProjectItem = { ...VIEW.items[0], fields: { ...VIEW.items[0].fields, Priority: 'P0' } };
  fetchMock.mockImplementation(async (_input, init) => (init?.method === 'POST' ? jsonRes({ fields: [], row: written }) : jsonRes(VIEW)));
  renderTable();
  await screen.findByText('3 de 3');
  within(rowOf('#12')).getByRole('button', { name: 'editar Priority' }).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'P0' }));
  await waitFor(() => expect(within(rowOf('#12')).getByText('P0')).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith('/sources/roadmap/items/roadmap%3APVTI_12/fields', expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'Priority', value: 'P0' }) }));
  expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/sources/roadmap/project')).toHaveLength(1);
});

test('the footer explains the table in English too: ⌄ cells edit, the dividers resize, ⇧↵ opens the issue (#60)', async () => {
  setLanguage('en');
  renderTable();
  expect(await screen.findByText('cells with ⌄ are editable · drag the dividers to resize · ⇧↵ opens the issue')).toBeInTheDocument();
});
