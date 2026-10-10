import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file (#355): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx), so the menu is opened once
// and every state below arrives through rerender; the one confirm at the end closes it for good. The item id never changes between them:
// a new one would remount the task and close the menu, so the board task is the same task with local unset.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'local:1', id: 'HIVE-1', title: 'Local', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true, ...extra,
});
const RUNNING: Worker = { id: 's1', status: 'working', activityId: activityIdOf('local:1'), runId: 'W1' };
const state = (c: Task, workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const menu = (): HTMLElement => screen.getByRole('menu');
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click › excluir tarefa…: absent on a board task; last on a Hive task, after excluir atividade…, in the destructive colour, disabled with the reason while a run holds it or a delete activity runs; stopped, it confirms that the worktree and branch go too and posts close with no body (#355, #542)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Flow state={state(task())} />);
  fireEvent.contextMenu(screen.getByText('#HIVE-1 Local').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'abrir sessão livre…' })).toBeInTheDocument();
  expect(within(menu()).queryByRole('menuitem', { name: /^excluir tarefa/ })).not.toBeInTheDocument();

  rerender(<Flow state={state(task({ created: true, workerId: 's1' }), [RUNNING])} />);
  expect(within(menu()).getByRole('menuitem', { name: 'excluir tarefa… · um worker ou sessão está executando nessa tarefa' })).toHaveAttribute('data-disabled');

  rerender(<Flow state={state(task({ created: true, deleting: true }))} />);
  const blocked = within(menu()).getByRole('menuitem', { name: 'excluir tarefa… · a atividade já está sendo excluída' });
  expect(blocked).toHaveAttribute('data-disabled');
  expect(blocked).toHaveClass('text-destructive');

  rerender(<Flow state={state(task({ created: true }))} />);
  const remove = within(menu()).getByRole('menuitem', { name: 'excluir tarefa…' });
  expect(remove).not.toHaveAttribute('data-disabled');
  expect(remove).toHaveClass('text-destructive', 'focus:text-destructive');
  expect(within(menu()).getAllByRole('menuitem').at(-1)).toBe(remove);
  expect(remove.previousElementSibling).toHaveTextContent(/^excluir atividade…/);
  await user.click(remove);
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent('Excluir esta tarefa? Ela sai do Hive de vez, e a worktree e a branch dela vão junto.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'excluir' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/local%3A1/close', expect.objectContaining({ method: 'POST', body: undefined })));
});
