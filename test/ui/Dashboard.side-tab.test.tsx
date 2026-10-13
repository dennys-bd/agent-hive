import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import { setLanguage } from '@/i18n';
import type { SidebarsPerView, Worker, State, } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', workerId: 's1', auto: true };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1', sessionId: 'abcdef123456', startedAt: '2026-09-27T10:00:00.000Z' };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [workerA], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});

function Home({ sidebarsPerView }: { sidebarsPerView?: SidebarsPerView }) {
  const [selected, setSelected] = useState<Selection | undefined>();
  return <Dashboard state={state} locale="pt-BR" tick={0} selected={selected} onSelect={setSelected} sidebarsPerView={sidebarsPerView} />;
}

// toggleSideTab is Ctrl+Alt+Shift+E off macOS (#585)
const sideKey = (): boolean => fireEvent.keyDown(document.body, { key: 'E', code: 'KeyE', ctrlKey: true, altKey: true, shiftKey: true });
// The window header's pane icons (#221): the shown pane's is pressed
const checked = (name: string): string | null => within(document.querySelector('header') as HTMLElement).getByRole('button', { name }).getAttribute('aria-pressed');

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('with an activity shown, the toggleSideTab key opens its closed sidebar and switches files and details, one press at a time (#585)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: 'atividades' }));
  await user.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByText('#1 Task A').closest('button') as HTMLElement);
  expect(screen.queryByRole('tab', { name: 'Detalhes' })).not.toBeInTheDocument(); // the right side starts closed
  expect(sideKey()).toBe(false);
  expect(checked('detalhes')).toBe('true');
  sideKey();
  expect(checked('arquivos')).toBe('true');
});

test('on the flow the key is not bound: it reaches the page untouched (#585)', () => {
  render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the window opens on Atividades (#746)
  expect(sideKey()).toBe(true);
});

const rightKey = (): void => { fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, altKey: true, shiftKey: true }); }; // toggleRight off macOS (#585)

test.each([
  [true, 'arquivos'],
  [false, 'detalhes'],
] as const)('a task picked from the flow with rightTab %s leaves the activity sidebar on %s (#821)', async (rightTab, tab) => {
  const user = userEvent.setup();
  render(<Home sidebarsPerView={{ left: true, right: true, rightTab }} />);
  await user.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByText('#1 Task A').closest('button') as HTMLElement);
  rightKey(); // the activities' right side open, on arquivos (redesign 07)
  expect(checked('arquivos')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' }));
  await user.click(within(screen.getByRole('main')).getByText('#1 Task A')); // a pick outside the activities
  fireEvent.click(screen.getByRole('button', { name: 'atividades' }));
  expect(checked(tab)).toBe('true');
});
