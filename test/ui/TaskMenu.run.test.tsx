import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { ConsoleContext } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import type { Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { type WithWork, movedWork } from '../fixtures/work';

// Its own file (#300): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx), so the menu is opened once and
// every state below arrives through rerender.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const workers: Worker[] = [{ id: 's1', status: 'empty' }];
const COMMANDS = { hive: ['Run Frontend', 'Run API'] };
const state = (c: Task, commands: Record<string, string[]>): State => movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async () => reply({ ok: true }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click › executar lists the commands of the task\'s workspace: absent when it has none, disabled without a worktree on disk; a pick posts /run and opens the console on the command\'s channel with the new run, no terminal tab (#300, #353)', async () => {
  const user = userEvent.setup();
  const openConsole = vi.fn();
  const board = (s: State) => <ConsoleContext.Provider value={openConsole}><Flow state={s} /></ConsoleContext.Provider>;
  const { rerender } = render(board(state(task({ worktree: '/wt' }), {})));
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'abrir sessão livre…' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'executar' })).not.toBeInTheDocument();
  rerender(board(state(task(), COMMANDS)));
  expect(screen.getByRole('menuitem', { name: 'executar' })).toHaveAttribute('data-disabled');
  rerender(board(state(task({ worktree: '/wt', worktreeGone: true }), COMMANDS)));
  expect(screen.getByRole('menuitem', { name: 'executar' })).toHaveAttribute('data-disabled');
  rerender(board(state(task({ worktree: '/wt' }), COMMANDS)));
  await user.click(screen.getByRole('menuitem', { name: 'executar' }));
  expect(await screen.findByRole('menuitem', { name: 'Run API' })).toBeInTheDocument();
  expect(screen.getByText('comandos de hive')).toBeInTheDocument(); // #542: the submenu's header and note
  expect(screen.getByText('saída aparece no console')).toBeInTheDocument();
  fetchMock.mockImplementationOnce(async () => reply({ ok: true, ptyId: 'W1' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Run Frontend' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/run', expect.objectContaining({ method: 'POST', body: JSON.stringify({ command: 'Run Frontend' }) })));
  await waitFor(() => expect(openConsole).toHaveBeenCalledWith('command:hive:Run Frontend', 'W1'));
});
