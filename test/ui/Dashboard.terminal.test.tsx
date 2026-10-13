import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import { setLanguage } from '@/i18n';
import type { Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

// Two running tasks: every run is a pty of the daemon's (#251, #378), which the UI opens in the center as its task's activity (#457).
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const taskB: WithWork = { item: { itemId: 'B', id: '2', title: 'Task B', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's2' };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const workerB: Worker = { id: 's2', status: 'working', activityId: activityIdOf('B'), runId: 'W2' };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 2, workers: [workerA, workerB], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA, taskB], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const atividades = (): HTMLElement => screen.getByRole('region', { name: 'Atividades' }); // its sidebar, which has no tab (redesign 03)

test('a board task\'s abrir opens its task\'s activity in the center, Atividades shown (#251, #457)', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('hive', { focusDetached: vi.fn(async () => false), onDock: vi.fn(), onCloseKey: vi.fn(), detachedPtys: vi.fn(async () => []) });
  render(<Dashboard state={state} locale="pt-BR" tick={0} onSelect={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'fluxo' })); // the window opens on Atividades (#746)
  await user.click(screen.getAllByRole('button', { name: 'abrir' })[0]); // the board's tasks, A then B
  await vi.waitFor(() => expect(atividades()).toBeVisible());
  expect(screen.getByRole('region', { name: '#1 Task A · etapa' })).toBeVisible();
  expect(screen.queryByRole('main')).not.toBeInTheDocument();
  expect(FakeWebSocket.all.map((s) => s.path)).toEqual(['/ptys/W1/pty']);
});

test('a run with a detached window of its own (#252) raises that window and leaves the board and the selection alone (#457)', async () => {
  const user = userEvent.setup();
  const focusDetached = vi.fn(async () => true);
  vi.stubGlobal('hive', { focusDetached, onDock: vi.fn(), onCloseKey: vi.fn(), detachedPtys: vi.fn(async () => []) });
  render(<Dashboard state={state} locale="pt-BR" tick={0} onSelect={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'fluxo' })); // the window opens on Atividades (#746)
  await user.click(screen.getAllByRole('button', { name: 'abrir' })[0]);
  await vi.waitFor(() => expect(focusDetached).toHaveBeenCalledWith('W1'));
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(atividades()).not.toBeVisible();
  expect(FakeWebSocket.all).toEqual([]);
});
