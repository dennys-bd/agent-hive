import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import { setLanguage } from '@/i18n';
import { DEFAULT_DOCK_LAYOUT, moveTo } from '@/lib/dock-layout';
import { readView, resetViewState } from '@/lib/view-state';
import type { Task, Terminal, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

// Task A runs its stage and a terminal, task B a terminal only, task C nothing (#457)
const T0 = '2026-09-27T10:00:00.000Z';
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const taskB: Task = { item: { itemId: 'B', id: '2', title: 'Task B', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const taskC: Task = { item: { itemId: 'C', id: '3', title: 'Task C', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1', sessionId: 'abcdef123456', startedAt: T0 };
const shellA: Terminal = { terminalId: 'W2', activityId: activityIdOf('A'), startedAt: T0, cwd: '/repo' };
const shellB: Terminal = { terminalId: 'W3', activityId: activityIdOf('B'), startedAt: T0, cwd: '/repo' };
const base: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [workerA], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA, taskB, taskC], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [shellA, shellB],
});

// The selection as App holds it: a new object on every pick, each one recorded
function Home({ state, calls = [] }: { state: State; calls?: (Selection | undefined)[] }) {
  const [selected, setSelected] = useState<Selection | undefined>();
  const onSelect = (s?: Selection): void => { calls.push(s); setSelected(s); };
  return <Dashboard state={state} locale="pt-BR" tick={0} selected={selected} onSelect={onSelect} />;
}

const group = (side: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-dock="${side}"]`);
const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Atividades' });
const row = (label: string): HTMLElement => within(nav()).getByText(label).closest('button')!;
// The left panel opens on Atividades (#746); the window header's fluxo shows the Automação sidebar (#533). Neither has a tab of its own (redesign 03)
const view = (name: string): HTMLElement => screen.getByRole('radio', { name: new RegExp(name) });
const showActivities = (): void => { fireEvent.click(view('atividades')); };
const rightKey = (): void => { fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, altKey: true, shiftKey: true }); }; // toggleRight off macOS (#452, #585)
const home = (): HTMLElement => screen.getByRole('heading', { name: 'Nenhuma atividade aberta' });
const centerTabs = (): [string | null, string | null][] =>
  within(screen.getByRole('tablist', { name: 'abas' })).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]);
const centerLayouts = (): Record<string, unknown> => (readView('centerLayouts') ?? {}) as Record<string, unknown>;

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('the window opens on Atividades: Home in the center and the Atividades sidebar on the left, Automação mounted beside it, listing every task with a live run in board order (#456, #457, #458, #746)', () => {
  render(<Home state={base} />);
  expect(home()).toBeInTheDocument(); // nothing picked (#458)
  expect(screen.queryByRole('main')).not.toBeInTheDocument();
  expect(view('atividades')).toHaveAttribute('aria-checked', 'true');
  const left = group('left')!;
  expect(within(left).queryByRole('tab')).not.toBeInTheDocument(); // each sidebar draws its own header (redesign 03, 09)
  expect(within(left).getByRole('region', { name: 'Atividades' })).toBeVisible();
  expect(within(left).getByRole('region', { name: 'Automação' })).not.toBeVisible();
  expect(left).toContainElement(nav());
  expect(within(nav()).getAllByRole('button', { name: /^#/ }).map((button) => within(button).getByText(/^#/).textContent)).toEqual(['#1 Task A', '#2 Task B']);
});

test('picking an activity shows its stage run alone in the center; once the task has no live run left, its layout is deleted and Home shows (#457, #458)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Home state={base} />);
  showActivities();
  await user.click(row('#1 Task A'));
  expect(row('#1 Task A')).toHaveAttribute('aria-current', 'true');
  expect(screen.queryByRole('main')).not.toBeInTheDocument();
  expect(centerTabs()).toEqual([['Claude · abcdef12', 'true']]); // the stage run alone: the task's terminal opens only on request (#458)
  expect(FakeWebSocket.all.map((socket) => socket.path)).toEqual(['/ptys/W1/pty']);
  expect(screen.getByRole('region', { name: '#1 Task A · etapa' })).toBeVisible();
  expect(group('bottom')).toBeNull(); // the dock has no bottom side
  await user.click(screen.getByRole('tab', { name: 'Claude · abcdef12' })); // a click stores the layout
  expect(Object.keys(centerLayouts())).toEqual(['A']);
  rerender(<Home state={{ ...base, workers: [], terminals: [shellB] }} />);
  expect(home()).toBeInTheDocument();
  expect(screen.queryByRole('main')).not.toBeInTheDocument();
  expect(centerLayouts()).toEqual({});
  expect(within(nav()).getAllByRole('button', { name: /^#/ })).toHaveLength(1);
});

test('picking an activity selects its task for Detalhes without opening its closed panel, and an open Detalhes follows the next pick (#457)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home state={base} calls={calls} />);
  showActivities();
  await user.click(row('#1 Task A'));
  expect(calls).toEqual([{ taskId: 'A', fromActivity: true }]);
  expect(screen.queryByRole('tab', { name: 'Detalhes' })).not.toBeInTheDocument(); // the right panel stays closed
  rightKey();
  await user.click(within(group('right')!).getByRole('radio', { name: 'detalhes' })); // an activity's sidebar opens on arquivos (redesign 07)
  expect(screen.getByRole('heading', { name: '#1 Task A' })).toBeVisible();
  await user.click(row('#2 Task B'));
  expect(screen.getByRole('heading', { name: '#2 Task B' })).toBeVisible();
  expect(calls).toEqual([{ taskId: 'A', fromActivity: true }, { taskId: 'B', fromActivity: true }]);
});

test('Automação shows the board and keeps the pick; Atividades brings the same activity back with its layout (#458)', async () => {
  const user = userEvent.setup();
  resetViewState({ centerLayouts: {
    A: { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W2' }], active: 1 }, focused: 'g1' },
  } });
  render(<Home state={base} />);
  showActivities();
  await user.click(row('#1 Task A'));
  expect(centerTabs()).toEqual([['Claude · abcdef12', 'false'], ['Terminal', 'true']]);
  await user.click(view('fluxo'));
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: 'abas' })).not.toBeInTheDocument();
  showActivities();
  expect(row('#1 Task A')).toHaveAttribute('aria-current', 'true');
  expect(centerTabs()).toEqual([['Claude · abcdef12', 'false'], ['Terminal', 'true']]);
});

test('activating another tab docked on the left, or closing the left panel, leaves the center as it is (#458)', async () => {
  const user = userEvent.setup();
  resetViewState({ dockLayout: moveTo(DEFAULT_DOCK_LAYOUT, 'detail', 'left') });
  render(<Home state={base} />);
  showActivities();
  await user.click(row('#1 Task A'));
  await user.click(within(group('left')!).getByRole('tab', { name: 'Detalhes' }));
  expect(screen.getByRole('region', { name: '#1 Task A · etapa' })).toBeVisible();
  fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true }); // Cmd+B closes the left panel (#452)
  expect(screen.getByRole('region', { name: '#1 Task A · etapa' })).toBeVisible();
  fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true });
  await user.click(within(group('left')!).getByRole('tab', { name: 'Automação' })); // beside Detalhes, which has no header of its own here
  await user.click(within(group('left')!).getByRole('tab', { name: 'Detalhes' }));
  expect(screen.getByRole('main')).toBeInTheDocument();
});

test('the header lists atividades then fluxo; Cmd+1 / Cmd+2 and the switch show the Atividades and Automação tabs, the center following (#533, #746)', async () => {
  render(<Home state={base} />);
  expect(within(document.querySelector('header')!).getAllByRole('radio').map((item) => item.textContent)).toEqual(['atividadesCtrl+1', 'fluxoCtrl+2']); // jsdom runs as off macOS

  fireEvent.keyDown(document.body, { key: '2', code: 'Digit2', ctrlKey: true });
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(view('fluxo')).toHaveAttribute('aria-checked', 'true');

  fireEvent.keyDown(document.body, { key: '1', code: 'Digit1', ctrlKey: true });
  expect(home()).toBeInTheDocument();
  expect(view('atividades')).toHaveAttribute('aria-checked', 'true');
  expect(within(group('left')!).getByRole('region', { name: 'Atividades' })).toBeVisible();

  await userEvent.setup().click(view('fluxo'));
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(within(group('left')!).getByRole('region', { name: 'Automação' })).toBeVisible();
});

test('a board whose last poll failed shows its error above the board (#180, #533)', () => {
  render(<Dashboard state={{ ...base, syncs: { notes: { error: 'project not found' } } }} hasSource locale="pt-BR" tick={0} onSelect={() => {}} />);
  fireEvent.click(view('fluxo')); // the window opens on Atividades (#746)
  expect(within(screen.getByRole('main')).getByText('source notes: project not found')).toBeInTheDocument();
});

test('a picked activity shows its bar over the center: the title, the facts, dormir on the focused run and the ⋯ (#536)', async () => {
  const user = userEvent.setup();
  render(<Home state={base} />);
  showActivities();
  await user.click(row('#1 Task A'));
  const bar = document.querySelector<HTMLElement>('[data-activity-bar]');
  expect(bar).not.toBeNull();
  const inBar = within(bar as HTMLElement);
  expect(inBar.getByText('#1 Task A')).toBeInTheDocument();
  expect(inBar.getByText(/^etapa dev · /)).toHaveTextContent(/ tokens$/);
  expect(inBar.getByRole('button', { name: 'dormir' })).toBeEnabled(); // W1, the focused group's shown run
  expect(inBar.getByRole('button', { name: 'mais ações' })).toBeInTheDocument();
});
