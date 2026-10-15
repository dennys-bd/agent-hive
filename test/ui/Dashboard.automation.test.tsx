import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import { setLanguage } from '@/i18n';
import { DEFAULT_DOCK_LAYOUT } from '@/lib/dock-layout';
import { readView, resetViewState } from '@/lib/view-state';
import type { Task, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

// Its own file (#456): Radix's ContextMenu opens once per file under jsdom (#377), and Dashboard.dock.test.tsx spends its one on the Terminal tab.
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [workerA], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
const saved = (): unknown => readView('dockLayout') ?? null;
const group = (side: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-dock="${side}"]`);

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const showFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); }; // the window opens on Atividades (#746)

test('Automação and Atividades offer no move: they stay on the left, and a stored layout with Automação on the right reads as the defaults (#456, #458)', () => {
  resetViewState({ dockLayout: { ...DEFAULT_DOCK_LAYOUT, docks: { automation: 'right', activities: 'left', detail: 'right' } } });
  render(<Dashboard state={state} locale="pt-BR" tick={0} onSelect={() => {}} />);
  showFlow();
  expect(within(group('left')!).getByRole('region', { name: 'Automação' })).toBeVisible();
  expect(within(group('left')!).getByRole('region', { name: 'Atividades' })).toBeInTheDocument();
  expect(within(group('left')!).queryAllByRole('tab')).toEqual([]); // no tab to right-click: nothing offers a move (redesign 09)
  expect(group('right')).toHaveStyle({ opacity: '0' }); // the defaults: the right side closed
  expect(saved()).toMatchObject({ docks: { automation: 'left', activities: 'left' } });
});

test('the brand\'s mark is coloured by the effective signal; without one it falls back to the manual signal (#456, #357, #227)', () => {
  const { rerender } = render(<Dashboard state={{ ...state, signal: 'yellow' }} locale="pt-BR" tick={0} onSelect={() => {}} />);
  const mark = (): Element | null => document.querySelector('header [data-signal]');
  expect(mark()).toHaveAttribute('data-signal', 'yellow');
  const effective = { signal: 'red' as const, floor: { signal: 'green' as const }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} };
  rerender(<Dashboard state={{ ...state, signal: 'yellow' }} effective={effective} locale="pt-BR" tick={0} onSelect={() => {}} />);
  expect(mark()).toHaveAttribute('data-signal', 'red');
});

test('a hive pick holds with no source configured and leaves only the tasks created in the Hive in the flow (#665)', async () => {
  const user = userEvent.setup();
  const taskB: Task = { item: { itemId: 'board:B', id: '2', title: 'Task B', body: '', url: '', source: 'board' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, taskB] }} locale="pt-BR" tick={0} onSelect={() => {}} />);
  showFlow();
  const automation = within(screen.getByRole('region', { name: 'Automação' }));
  await user.click(automation.getByRole('button', { name: /^hive/ }));
  expect(automation.getByRole('button', { name: /^hive/ })).toHaveAttribute('aria-pressed', 'true');
  expect(within(screen.getByRole('main')).getByText('#1 Task A')).toBeInTheDocument();
  expect(within(screen.getByRole('main')).queryByText('#2 Task B')).not.toBeInTheDocument();
});

test('a card in a wait-for-CI stage offers tentar de novo only while the effective signal\'s row runs no workerless stage (#304, #727)', () => {
  const ciStage = { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi' as const, ciChecks: 'all' as const, rerunOnce: false };
  const taskC: Task = { item: { itemId: 'C', id: '3', title: 'Task C', body: '', url: '' }, stage: 'ci', boardColumn: 'CI', auto: false };
  const signals = { ...SIGNALS_DEFAULTS, red: { ...SIGNALS_DEFAULTS.red, workerless: false } };
  const ci: State = { ...state, signals, stages: [...state.stages, ciStage], tasks: [...state.tasks, taskC] };
  const limits = (signal: 'green' | 'red') => ({ signal, floor: { signal: 'green' as const }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} });
  const card = (): HTMLElement => within(screen.getByRole('main')).getByText('#3 Task C').closest('li')!;
  const { rerender } = render(<Dashboard state={ci} effective={limits('green')} locale="pt-BR" tick={0} onSelect={() => {}} />);
  showFlow();
  expect(within(card()).queryByRole('button', { name: 'tentar de novo' })).not.toBeInTheDocument(); // green runs it: the wait starts on its own
  rerender(<Dashboard state={ci} effective={limits('red')} locale="pt-BR" tick={0} onSelect={() => {}} />);
  expect(within(card()).getByRole('button', { name: 'tentar de novo' })).toBeInTheDocument(); // a rule brought red, whose row is off
});
