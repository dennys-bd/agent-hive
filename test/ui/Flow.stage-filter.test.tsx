import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import { readView, resetViewState } from '@/lib/view-state';
import type { Task, FilterRule, Worker, Stage, State, ItemFacets } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// A stage's view filter (#374), in a file of its own: Flow.test.tsx is long already. The kebab is a DropdownMenu and the filter a Dialog,
// and unlike a ContextMenu (see Flow.contextmenu.test.tsx) both open again and again in one jsdom file.

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const capped: Stage[] = [{ name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' }];
/** A board task; `facets` as the GitHub adapter fills them, absent as on a local task. */
const task = (id: string, stage: string, facets?: Partial<ItemFacets>, extra: Partial<WithWork> = {}): WithWork => ({
  item: {
    itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}`,
    ...(facets === undefined ? {} : { facets: { assignees: [], labels: [], fields: {}, ...facets } }),
  },
  stage, boardColumn: 'Ready', auto: true, ...extra,
});
const worker = (id: string, taskId?: string): Worker => ({ id, status: taskId ? 'working' : 'empty', ...(taskId ? { activityId: activityIdOf(taskId), ptyId: `w-${id}` } : {}) });
const state = (tasks: WithWork[], workers: Worker[], cols: Stage[] = stages): State =>
  withPointedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: workers.length, workers, stages: cols, tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] });
const titles = () => screen.getAllByText(/^#\d Task/).map((el) => el.textContent);
const saved = (): unknown => readView('stageFilters') ?? null;
const save = (value: unknown): void => resetViewState({ stageFilters: value });
const ANA: FilterRule = { field: 'assignee', op: 'any', values: ['ana'] };
const LABEL_X: FilterRule = { field: 'label', op: 'any', values: ['x'] };

// Radix opens a DropdownMenu on pointerdown, which jsdom does not deliver as a PointerEvent; the keyboard path opens the same menu.
const openStageMenu = async (user: ReturnType<typeof userEvent.setup>, index: number) => {
  screen.getAllByRole('button', { name: 'ações da etapa' })[index].focus();
  await user.keyboard('{Enter}');
};

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('Filtrar… opens a dialog whose pickers list the stage\'s own values; Aplicar hides every task that fails, a live one too, says how many it hides, saves the rules and posts nothing but the view state (#374, #484)', async () => {
  const user = userEvent.setup();
  const tasks = [
    task('1', 'dev', { assignees: ['ana'], labels: ['bug'] }, { workerId: 's1' }), // running: hidden all the same
    task('2', 'dev', { assignees: ['Bia'] }),
    task('3', 'dev'), // no facets, as a local task
    task('4', 'review', { assignees: ['caio'] }),
  ];
  render(<Flow state={state(tasks, [worker('s1', 'I1')])} />);
  await openStageMenu(user, 0);
  await user.click(screen.getByRole('menuitem', { name: 'Filtrar…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Filtrar dev' });
  await user.click(within(dialog).getByRole('button', { name: '+ filtro' })); // a new rule: responsável, é qualquer um de
  await user.click(within(dialog).getByRole('combobox', { name: 'valores' }));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['nenhum', 'ana', 'Bia']); // nenhum, then dev's own assignees (#524): review's caio is not offered, nor @me
  await user.click(screen.getByRole('option', { name: 'Bia' }));
  await user.keyboard('{Escape}'); // closes the values popover only: the topmost layer takes Escape
  await user.click(within(dialog).getByRole('button', { name: 'Aplicar' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(titles()).toEqual(['#2 Task 2', '#4 Task 4']);
  expect(screen.getByText('2 ocultos')).toBeInTheDocument();
  expect(within(screen.getAllByRole('heading', { level: 3 })[0].parentElement!).getByText('3')).toBeInTheDocument(); // the header still counts the whole stage
  expect(saved()).toEqual({ dev: [{ field: 'assignee', op: 'any', values: ['Bia'] }] });
  expect(fetchMock.mock.calls.filter(([url]) => !String(url).startsWith('/view-state/'))).toEqual([]); // the board filter in Settings is never sent
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none')); // the menu-then-dialog hand-off leaves the page clickable
});

test('a saved filter applies on load: it hides its tasks and says how many; a filter saved for a stage the Hive no longer has is ignored (#374)', () => {
  save({ spec: [{ field: 'label', op: 'none', values: ['blocked'] }], gone: [LABEL_X] });
  const tasks = ['1', '2', '3', '4', '5'].map((id) => task(id, 'spec', { labels: id === '2' || id === '4' ? ['blocked'] : [] }, id === '2' ? { workerId: 's1' } : {}));
  render(<Flow state={state(tasks, [worker('s1', 'I2')], capped)} />);
  expect(titles()).toEqual(['#1 Task 1', '#3 Task 3', '#5 Task 5']);
  expect(screen.getByText('2 ocultos')).toBeInTheDocument();
  expect(within(screen.getByRole('heading', { level: 3 }).parentElement!).getByText('5')).toBeInTheDocument();
});

test('Limpar filtro in a stage\'s header shows its every task again and removes it from storage; that write drops a stage the Hive no longer has (#374)', async () => {
  const user = userEvent.setup();
  save({ dev: [ANA], review: [LABEL_X], gone: [LABEL_X] });
  render(<Flow state={state([task('1', 'dev', { assignees: ['ana'] }), task('2', 'dev'), task('3', 'review', { labels: ['x'] })], [worker('s1')])} />);
  expect(titles()).toEqual(['#1 Task 1', '#3 Task 3']);
  expect(screen.getByText('1 oculto')).toBeInTheDocument();
  expect(screen.getByText('0 ocultos')).toBeInTheDocument(); // review is filtered though its rule hides nothing: it still says so
  await user.click(screen.getAllByRole('button', { name: 'Limpar filtro' })[0]);
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3']);
  expect(screen.getAllByRole('button', { name: 'Limpar filtro' })).toHaveLength(1);
  expect(saved()).toEqual({ review: [LABEL_X] });
});

test('a stage whose every task fails its filter says so instead of vazia; the kebab offers Limpar filtro only while the stage has a rule, and picking it shows the tasks again (#374)', async () => {
  const user = userEvent.setup();
  save({ dev: [LABEL_X] });
  render(<Flow state={state([task('1', 'dev'), task('2', 'dev')], [worker('s1')])} />);
  expect(screen.getByText('Nenhuma tarefa passa no filtro')).toBeInTheDocument();
  expect(screen.getAllByText('vazia')).toHaveLength(1); // review really is empty
  await openStageMenu(user, 1); // review: no rule
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['restaurar ordem da source', 'Filtrar…']);
  await user.keyboard('{Escape}');
  await openStageMenu(user, 0);
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['restaurar ordem da source', 'Filtrar…', 'Limpar filtro']);
  await user.click(screen.getByRole('menuitem', { name: 'Limpar filtro' }));
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2']);
  expect(screen.queryByText('Nenhuma tarefa passa no filtro')).not.toBeInTheDocument();
  expect(saved()).toEqual({});
});

test('the dialog opens on the saved rules, and cancelar leaves them as they were even after the draft removed one (#374)', async () => {
  const user = userEvent.setup();
  save({ dev: [ANA] });
  render(<Flow state={state([task('1', 'dev', { assignees: ['ana'] }), task('2', 'dev')], [worker('s1')])} />);
  await openStageMenu(user, 0);
  await user.click(screen.getByRole('menuitem', { name: 'Filtrar…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Filtrar dev' });
  expect(within(dialog).getAllByTestId('filter-rule')).toHaveLength(1);
  await user.click(within(dialog).getByRole('button', { name: 'remover filtro' }));
  await user.click(within(dialog).getByRole('button', { name: 'cancelar' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(titles()).toEqual(['#1 Task 1']);
  expect(saved()).toEqual({ dev: [ANA] });
});

test('a stage filtered with bloqueado não está hides a task without facets whose dependency is still open and shows the free ones, facets or not (#441)', () => {
  save({ dev: [{ field: 'blocked', op: 'none' }] });
  const blocked = (c: Task): WithWork => ({ ...c, item: { ...c.item, blockedBy: ['9'] } });
  render(<Flow state={state([task('1', 'dev'), blocked(task('2', 'dev')), task('3', 'dev', { labels: ['x'] })], [worker('s1')])} />);
  expect(titles()).toEqual(['#1 Task 1', '#3 Task 3']); // #1 and #2 carry no facets
  expect(screen.getByText('1 oculto')).toBeInTheDocument();
});
