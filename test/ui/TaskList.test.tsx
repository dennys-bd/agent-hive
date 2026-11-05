import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { TaskList } from '@/components/tasks/TaskList';
import { useDisplayOptions } from '@/hooks/use-flow-view';
import { setLanguage } from '@/i18n';
import { readFlowView } from '@/lib/flow-view';
import { resetViewState } from '@/lib/view-state';
import { flatten } from '../../src/flows';
import type { Flow, Item, Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// The list view (#577): its groups, their headers and collapse, a row's cells, paging and the filters. The row's action, click and menu are
// TaskListRow.test.tsx's.
const stage = (name: string): Stage => ({ name, from: {}, prompt: '/hive-build {url}' });
const FLOWS: Flow[] = [{ name: 'feature', stages: [stage('spec'), stage('build')], transitions: [] }, { name: 'bug', stages: [stage('triage')], transitions: [] }];
const task = (id: string, at?: string, item: Partial<Item> = {}, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...item }, ...(at === undefined ? {} : { stage: at }), boardColumn: 'Ready', auto: true, ...extra,
});
const state = (tasks: WithWork[], workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], flows: FLOWS, ...flatten(FLOWS), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive', 'site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const waitingOn = (itemId: string): Worker => ({ id: `s-${itemId}`, status: 'waiting', activityId: activityIdOf(itemId), runId: `W-${itemId}` });
function Harness({ state: s }: { state: State }) {
  const display = useDisplayOptions();
  return <TaskList state={s} display={display} />;
}
const rowIds = (): string[] => [...document.querySelectorAll('tr[data-task-id]')].map((tr) => tr.getAttribute('data-task-id') ?? '');
const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`tr[data-task-id="${id}"]`)!;
const cells = (id: string): string[] => [...row(id).children].map((td) => td.textContent ?? '');
const header = (name: RegExp): HTMLElement => screen.getByRole('button', { name });
const headers = (): string[] => [...document.querySelectorAll('table button[aria-expanded]')].map((b) => b.textContent ?? '');
beforeEach(() => { setLanguage('pt'); resetViewState(); });
afterEach(() => resetViewState());

test('one table: the five column headers, a group per flow in config order and sem fluxo last with its hint, a flow with no task left out (#577 decisions 2, 3, 11)', () => {
  render(<Harness state={state([task('1', 'build'), task('2'), task('3', 'spec')])} />);
  const table = screen.getByRole('table', { name: 'todas em lista' });
  expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['tarefa', 'etapa', 'status', 'source', 'ação']);
  expect(headers()).toEqual(['feature2', 'sem fluxosem etapas · nenhum worker conduz1']);
  expect(rowIds()).toEqual(['I3', 'I1', 'I2']);
});

test('a group header counts its tasks and shows ● N of those waiting for you or for an approval in the waiting colour; none at 0 (#577 decision 3)', () => {
  render(<Harness state={state([task('1', 'spec'), task('2', 'spec', {}, { approval: { since: '2026-11-05T10:00:00.000Z' } }), task('3', 'triage')], [waitingOn('I1')])} />);
  expect(header(/^feature/)).toHaveTextContent(/^feature2● 2$/);
  expect(within(header(/^feature/)).getByText('● 2')).toHaveClass('text-signal-yellow');
  expect(header(/^bug/)).toHaveTextContent(/^bug1$/);
});

test('a header collapses and expands its group; the collapsed groups go to listCollapsed, sem fluxo as \'\', and are read back on a remount (#577 decision 4)', async () => {
  const user = userEvent.setup();
  const s = state([task('1', 'spec'), task('2')]);
  const { unmount } = render(<Harness state={s} />);
  await user.click(header(/^feature/));
  expect([header(/^feature/).getAttribute('aria-expanded'), rowIds()]).toEqual(['false', ['I2']]);
  await user.click(header(/^sem fluxo/));
  expect(readFlowView().listCollapsed).toEqual(['feature', '']);
  unmount();
  render(<Harness state={s} />);
  expect(rowIds()).toEqual([]);
  await user.click(header(/^feature/));
  expect([rowIds(), readFlowView().listCollapsed]).toEqual([['I1'], ['']]);
});

test('a row: the workspace square, ↳ indented by depth, ⑂ on an epic, the ◌ hint with its tooltip, the stage or sem fluxo, the status dot and word in the status colour, the source (#577 decisions 6, 8)', () => {
  const s = state([
    task('1', 'spec', { children: ['I2', 'I9'], closedChildren: ['I9'] }, { workspace: 'site' }),
    task('2', 'build', { parent: 'I1', source: 'roadmap' }),
    task('3', undefined, {}, { outOfListing: 'listing' }),
  ], [waitingOn('I1')]);
  render(<Harness state={s} />);
  expect(rowIds()).toEqual(['I1', 'I2', 'I3']); // the tree is on: one exists
  expect(cells('I1').slice(0, 4)).toEqual(['#1 Task 1⑂ 2 filhas · 1/2', 'spec', 'esperando você', 'hive']);
  expect(cells('I2').slice(0, 4)).toEqual(['↳#2 Task 2', 'build', 'nova', 'roadmap']);
  expect(cells('I3').slice(0, 4)).toEqual(['#3 Task 3◌ fora da listagem', 'sem fluxo', 'nova', 'hive']);
  expect(row('I1').querySelector('[title="site"]')).toHaveClass('size-2');
  expect(row('I2').querySelector<HTMLElement>('td')!.style.paddingLeft).toBe('20px');
  expect(within(row('I3')).getByText('◌ fora da listagem')).toHaveAttribute('title', 'a última leitura não trouxe este item · segue sincronizando pelo item');
  const status = row('I1').children[2];
  expect(status.querySelector('[aria-hidden="true"]')).toHaveClass('bg-waiting');
  expect(within(status as HTMLElement).getByText('esperando você')).toHaveClass('text-waiting');
});

test('a group shows 25 rows and +N tarefas for the rest; the button shows the next page (#577 decision 7)', async () => {
  const user = userEvent.setup();
  render(<Harness state={state(Array.from({ length: 30 }, (_, i) => task(String(i + 1), 'spec')))} />);
  expect(rowIds()).toHaveLength(25);
  await user.click(screen.getByRole('button', { name: /^\+5 tarefas · / }));
  expect(rowIds()).toHaveLength(30);
  expect(screen.queryByRole('button', { name: /^\+\d+ tarefas · / })).not.toBeInTheDocument();
});

test('the list reads exibir\'s sources and the header\'s search, and a group left with no task goes (#577 decision 1)', async () => {
  const user = userEvent.setup();
  resetViewState({ flowView: { sourcesOff: ['roadmap'] } });
  render(<Harness state={state([task('1', 'spec', { source: 'roadmap' }), task('2', 'spec'), task('3', 'triage'), task('4')])} />);
  expect(rowIds()).toEqual(['I2', 'I3', 'I4']);
  await user.type(screen.getByRole('textbox', { name: 'buscar tarefas' }), 'Task 3');
  expect(rowIds()).toEqual(['I3']);
  expect(screen.queryByRole('button', { name: /^feature/ })).not.toBeInTheDocument();
});
