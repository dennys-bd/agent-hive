import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';
import { firstFlow } from './flow-of.js';

// Its own file: Radix's ContextMenu opens once per file under jsdom, so every state arrives through rerender (same item id, or the task would
// remount and close the menu); the pick at the end closes it for good.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({ item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra });
const RUNNING: Worker = { id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' };
const state = (c: Task, workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], ...flowed(stages, []), tasks: [c], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, semaphores: {}, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const view = (c: Task, workers: Worker[] = []) => <Flow state={state(c, workers)} flow={firstFlow(state(c, workers))} />;
const leave = (): HTMLElement => screen.getByRole('menuitem', { name: /^tirar do fluxo/ });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('in the flow, tirar do fluxo follows mover para etapa; disabled with its reason on a second line while a run holds the task, it is an epic or a source action is under way; picked, it posts leave-flow and the view stays (#576 decisions 10, 11, 12)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(view(task({ workerId: 's1' }), [RUNNING]));
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  await screen.findByRole('menuitem', { name: /^tirar do fluxo/ });
  expect(leave().previousElementSibling).toHaveTextContent(/^mover para etapa/);
  expect(leave()).toHaveAttribute('data-disabled');
  expect(within(leave()).getByText('um worker ou sessão está executando nessa tarefa')).toHaveClass('text-muted-foreground', 'text-xs');
  rerender(view({ ...task(), item: { ...task().item, epic: { follows: 'behind', switchAt: 'dev' } } }));
  expect(within(leave()).getByText('um epic segue as etapas das filhas')).toBeInTheDocument();
  rerender(view(task({ leaving: true })));
  expect(within(leave()).getByText('uma ação na source está em andamento')).toBeInTheDocument();
  rerender(view(task()));
  expect(leave()).not.toHaveAttribute('data-disabled');
  expect(leave()).toHaveTextContent(/^tirar do fluxo$/);
  await user.click(leave());
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/leave-flow', expect.objectContaining({ method: 'POST' })));
  expect(screen.getByText('#1 Task 1')).toBeInTheDocument(); // no navigation: the card leaves with the next state (decision 12)
});
