import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

// One running task: its run makes it an activity (#457)
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [workerA], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});

function Home({ initial }: { initial?: Selection }) {
  const [selected, setSelected] = useState<Selection | undefined>(initial);
  return <Dashboard state={state} locale="pt-BR" tick={0} selected={selected} onSelect={setSelected} />;
}

const view = (name: string): void => { fireEvent.click(within(screen.getByRole('navigation', { name: 'views' })).getByRole('button', { name })); };
const center = (): HTMLElement => document.querySelector<HTMLElement>('[data-header-column="center"]')!;
const flowBar = (): HTMLElement | null => screen.queryByRole('region', { name: 'fluxo' });

beforeEach(() => {
  setLanguage('pt');
  resetViewState();
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('in the flow view the flow\'s bar sits in the header\'s center column, not in the center pane (#295)', () => {
  render(<Home />);
  view('fluxo');
  const bar = flowBar()!;
  expect(center()).toContainElement(bar);
  expect(screen.getByRole('main')).not.toContainElement(bar);
  expect(within(bar).getByText('todas as sources')).toBeInTheDocument();
});

test('under Atividades the home has no bar, an open activity its own and no flow bar; back on the flow, the flow\'s bar again (#221, #295, #596)', () => {
  render(<Home />);
  expect(flowBar()).toBeNull(); // the window opens on Atividades' home (#746)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByRole('button', { name: /#1 Task A/ }));
  expect(center()).toContainElement(document.querySelector<HTMLElement>('[data-activity-bar]'));
  expect(flowBar()).toBeNull();
  view('fluxo');
  expect(center()).toContainElement(flowBar());
  expect(center().querySelector('[data-activity-bar]')).toBeNull();
});

test('in the flow view the details pane draws no group header, no Detalhes tab and no ×: the header\'s detalhes icon names it and closes it (#221, #295)', () => {
  render(<Home initial={{ taskId: 'A' }} />);
  view('fluxo');
  const right = document.querySelector<HTMLElement>('[data-dock="right"]')!;
  expect(right).toContainElement(screen.getByRole('complementary', { name: 'detalhe' }));
  expect(within(right).queryByRole('tablist')).not.toBeInTheDocument();
  expect(within(right).queryByRole('button', { name: 'Fechar painel' })).not.toBeInTheDocument();
  const icon = within(screen.getByRole('banner')).getByRole('button', { name: 'detalhes' });
  expect(icon).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(icon);
  expect(within(screen.getByRole('banner')).getByRole('button', { name: 'abrir lateral direita' })).toBeEnabled();
});
