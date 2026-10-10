import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Stage, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { type WithWork, movedWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx). Every state below is reached through
// rerender while the one menu stays open.

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const workers: Worker[] = [{ id: 's1', status: 'empty' }];
const state = (tasks: WithWork[]): State =>
  movedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT }); // #629: the worktree and the mark on the task's activity
const BASES = { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] };
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
  new Response(JSON.stringify(String(input).endsWith('/bases') ? BASES : { ok: true, ptyId: 'W1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click › abrir sessão livre… on any task: disabled on one being cleaned; enabled on a blocked one, where it opens the Start dialog on sessão livre; abrir sessão attaches the run POST /open answered (#283, #249, #491, redesign 11)', async () => {
  const user = userEvent.setup();
  const focusDetached = vi.fn(async () => true);
  vi.stubGlobal('hive', { focusDetached });
  const blocked = task({ worktree: '/wt/hive-1-task-1', item: { ...task().item, blockedBy: ['9'] } }); // a blocker holds the stage run only (#491)
  const { rerender } = render(<Flow state={state([task({ deleting: true })])} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'abrir sessão livre…' })).toHaveAttribute('data-disabled');
  rerender(<Flow state={state([blocked])} />);
  const item = screen.getByRole('menuitem', { name: 'abrir sessão livre…' });
  expect(item).not.toHaveAttribute('data-disabled');
  fireEvent.click(item);
  const dialog = await screen.findByRole('dialog', { name: 'Iniciar #1' });
  expect(within(dialog).getByRole('radio', { name: 'sessão livre' })).toBeChecked();
  const open = within(dialog).getByRole('button', { name: /sessão livre/ });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/open', expect.objectContaining({ body: JSON.stringify({ kind: 'claude' }) }));
  await waitFor(() => expect(focusDetached).toHaveBeenCalledWith('W1'));
});
