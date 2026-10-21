import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Stage, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { movedWork, type WithWork } from '../fixtures/work';

// Its own file for the reason Flow.contextmenu.test.tsx gives: under jsdom Radix's ContextMenu opens once per file.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1', source: 'board' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const worker: Worker = { id: 's1', status: 'empty' };
const two = (c: WithWork): State => movedWork({ // #629: the worktree on the task's activity
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [worker], stages, tasks: [c], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive', 'site'], sourceWorkspaces: { board: 'site' }, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click › mover para workspace lists the Comb\'s workspaces with the current one marked and posts the choice; disabled with exclua a atividade antes once the task has a worktree (#179, #542)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Flow state={two(task({ worktree: '/w' }))} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  const locked = screen.getByRole('menuitem', { name: /^mover para workspace/ });
  expect(locked).toHaveAttribute('data-disabled');
  expect(locked).toHaveTextContent('exclua a atividade antes');
  rerender(<Flow state={two(task())} />);
  await user.click(screen.getByRole('menuitem', { name: 'mover para workspace' }));
  expect(await screen.findByRole('menuitem', { name: 'site' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('menuitem', { name: 'hive' })).not.toHaveAttribute('aria-current');
  expect(screen.getByRole('menuitem', { name: 'site' }).querySelector('svg')).toHaveClass('size-4'); // #231: not lucide's default 24px
  fireEvent.click(screen.getByRole('menuitem', { name: 'hive' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/workspace', expect.objectContaining({ method: 'POST', body: JSON.stringify({ workspace: 'hive' }) })));
});
