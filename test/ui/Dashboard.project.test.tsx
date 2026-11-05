import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { SourcesNav } from '@/components/FlowSources';
import { forgetProjects } from '@/hooks/use-project';
import { setLanguage } from '@/i18n';
import type { ProjectView, SourceConfig, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { flowed } from '../fixtures/main-flow.js';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

const source = (name: string, number: number): SourceConfig => ({ name, qualifyId: false, type: 'github', owner: 'acme', number, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flow: 'main' } }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' });
const NAV: SourcesNav = { sources: [source('roadmap', 6), source('notes', 8)], auth: 'cli' };
const TASK: Task = { item: { itemId: 'roadmap:PVTI_1', id: '1', title: 'Issue 1', body: '', url: '', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const VIEW: ProjectView = {
  statuses: [{ name: 'Ready', stage: 'dev' }], fields: [], builtins: {}, truncated: false,
  items: [{ itemId: 'roadmap:PVTI_1', id: '1', title: 'Issue 1', body: '', url: 'https://github.com/acme/r/issues/1', status: 'Ready', labels: [], assignees: [], fields: {}, pullRequests: [] }],
};
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed([{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], []), tasks: [TASK], sourceOrder: [], localCount: 0, benchmark: { experiments: [] },
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => jsonRes(String(input) === '/sources/roadmap/project' ? VIEW : { ok: true }));

beforeEach(() => {
  setLanguage('pt');
  forgetProjects();
  resetFakes();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const showFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'tarefas' })); }; // the window opens on Atividades (#746)
const main = () => within(screen.getByRole('main'));
const bar = () => within(document.querySelector<HTMLElement>('[data-header-column="center"]')!); // the flow's bar, in the window header (#295)
const automation = () => within(screen.getByRole('region', { name: 'Tarefas' }));

test('a source row opens its table with no tabs; hive opens the hive table; the flow row shows the flowchart (#571, #572, #583)', async () => {
  const user = userEvent.setup();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  expect(bar().queryAllByRole('tab')).toEqual([]);
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  expect(await main().findByText('1 itens · 1 tarefas')).toBeInTheDocument();
  expect(bar().queryAllByRole('tab')).toEqual([]);
  await user.click(automation().getByRole('button', { name: /^hive/ }));
  expect(await main().findByText('0 itens · 0 tarefas')).toBeInTheDocument(); // the state holds no hive task
  expect(main().getByRole('columnheader', { name: 'Workspace' })).toBeInTheDocument();
  expect(bar().getByText('hive')).toHaveClass('font-semibold');
  expect(bar().getByText('tarefas do hive · sem sync externo')).toBeInTheDocument();
  expect(main().queryByText('em breve')).not.toBeInTheDocument();
  expect(automation().getByRole('button', { name: /^hive/ })).toHaveAttribute('aria-pressed', 'true');
  await user.click(automation().getByRole('button', { name: /^main/ }));
  expect(bar().getByText('todas as sources')).toBeInTheDocument();
  expect(automation().getByRole('button', { name: /^main/ })).toHaveAttribute('aria-pressed', 'true');
});

test('the task column in the source table shows the flowchart and selects the task (#756, #571, #583)', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={onSelect} />);
  showFlow();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await main().findByText('1 itens · 1 tarefas');
  await user.click(main().getByRole('button', { name: 'main · dev ›' }));
  expect(onSelect).toHaveBeenCalledWith({ taskId: 'roadmap:PVTI_1' });
  expect(bar().getByText('todas as sources')).toBeInTheDocument();
});

test('+ tarefa creates a hive task outside the flow and stays on the table; once the state holds it the cell reads sem fluxo › (#583)', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const out = { ...VIEW.items[0], itemId: 'roadmap:PVTI_2', id: '2', title: 'Issue 2', url: 'https://github.com/acme/r/issues/2', out: 'filter' as const };
  fetchMock.mockImplementation(async (input) => {
    if (String(input) === '/sources/roadmap/project') return jsonRes({ ...VIEW, items: [...VIEW.items, out] });
    return jsonRes(String(input) === '/tasks' ? { id: 'HIVE-1', itemId: 'local:1' } : { ok: true });
  });
  const { rerender } = render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={onSelect} />);
  showFlow();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(await main().findByRole('button', { name: '+ tarefa' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({ method: 'POST' })));
  expect(bar().getByText('github project · acme')).toBeInTheDocument(); // still the source's table
  const created: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Issue 2', body: '', url: out.url, origin: out.itemId }, boardColumn: '', auto: false, created: true };
  rerender(<Dashboard state={{ ...state, tasks: [...state.tasks, created] }} locale="pt-BR" tick={0} sources={NAV} onSelect={onSelect} />);
  expect(await main().findByRole('button', { name: 'sem fluxo ›' })).toBeInTheDocument();
  expect(main().queryByRole('button', { name: '+ tarefa' })).not.toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});
