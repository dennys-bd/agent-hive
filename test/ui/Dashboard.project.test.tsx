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

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

const source = (name: string, number: number): SourceConfig => ({ name, qualifyId: false, type: 'github', owner: 'acme', number, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' });
const NAV: SourcesNav = { sources: [source('roadmap', 6), source('notes', 8)], auth: 'cli' };
const TASK: Task = { item: { itemId: 'roadmap:PVTI_1', id: '1', title: 'Issue 1', body: '', url: '', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const VIEW: ProjectView = {
  statuses: [{ name: 'Ready', stage: 'dev' }], fields: [], builtins: {}, truncated: false,
  items: [{ itemId: 'roadmap:PVTI_1', id: '1', title: 'Issue 1', body: '', url: 'https://github.com/acme/r/issues/1', status: 'Ready', labels: [], assignees: [], fields: {}, pullRequests: [] }],
};
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [TASK], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
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

const showFlow = (): void => { fireEvent.click(screen.getByRole('radio', { name: /fluxo/ })); }; // the window opens on Atividades (#746)
const main = () => within(screen.getByRole('main'));
const automation = () => within(screen.getByRole('region', { name: 'Automação' }));

test('the tabs show only with an external source picked; the native tab shows its table, and a new pick returns to the flow (#756)', async () => {
  const user = userEvent.setup();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  expect(main().queryByRole('tab', { name: 'GitHub Project' })).not.toBeInTheDocument(); // todas
  await user.click(automation().getByRole('button', { name: /^hive/ }));
  expect(main().queryByRole('tab', { name: 'GitHub Project' })).not.toBeInTheDocument();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  expect(main().getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
  await user.click(main().getByRole('tab', { name: 'GitHub Project' }));
  expect(await main().findByText('1 issues · 1 no fluxo')).toBeInTheDocument();
  await user.click(automation().getByRole('button', { name: /^notes/ }));
  expect(main().getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
  expect(main().queryByText(/issues ·/)).not.toBeInTheDocument();
});

test('fluxo › in the native view goes back to the flow tab and selects the task (#756)', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={onSelect} />);
  showFlow();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(main().getByRole('tab', { name: 'GitHub Project' }));
  await main().findByText('1 issues · 1 no fluxo');
  await user.click(main().getByRole('button', { name: 'fluxo ›' }));
  expect(onSelect).toHaveBeenCalledWith({ taskId: 'roadmap:PVTI_1' });
  expect(main().getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
});

test('a task created from the native view is selected once the state holds it, on the flow tab (#756)', async () => {
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
  await user.click(main().getByRole('tab', { name: 'GitHub Project' }));
  await user.click(await main().findByRole('button', { name: 'fluxo…' }));
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(main().getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true'));
  expect(onSelect).not.toHaveBeenCalledWith({ taskId: 'local:1' }); // App would drop a selection the state does not hold yet
  const created: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Issue 2', body: '', url: out.url, origin: out.itemId }, stage: 'dev', boardColumn: '', auto: false, created: true };
  rerender(<Dashboard state={{ ...state, tasks: [...state.tasks, created] }} locale="pt-BR" tick={0} sources={NAV} onSelect={onSelect} />);
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith({ taskId: 'local:1' }));
  // a hive task: the pick follows it to hive, or the flow filtered to roadmap would hide it
  expect(automation().getByRole('button', { name: /^hive/ })).toHaveAttribute('aria-pressed', 'true');
});
