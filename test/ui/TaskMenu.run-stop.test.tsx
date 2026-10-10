import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Terminal, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file (#353): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx).
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt',
};
const terminals: Terminal[] = [{ terminalId: 'W9', activityId: activityIdOf('I1'), startedAt: '2026-09-27T10:00:00.000Z', cwd: '/repo', command: 'Run Frontend' }];
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [{ id: 's1', status: 'empty' }], terminals, stages, tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive'], sourceWorkspaces: {}, commands: { hive: ['Run Frontend', 'Run API'] }, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click › executar reads Parar <nome> for the command live on the task, the other still a start; confirming posts stop for that run, dormir never lists the command run (#353)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'abrir sessão livre…' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'dormir' })).not.toBeInTheDocument(); // its own item stops it
  await user.click(screen.getByRole('menuitem', { name: 'executar' }));
  expect(await screen.findByRole('menuitem', { name: 'Run API' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Parar Run Frontend' }));
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent('Parar essa execução? O processo termina e a sessão fica salva.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'parar' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/ptys/W9/stop', expect.objectContaining({ method: 'POST' })));
});
