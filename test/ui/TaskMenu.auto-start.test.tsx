import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Task, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

// Its own file: Radix's ContextMenu opens once per file under jsdom. começar sozinho keeps the menu open, so both flips happen in it.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<Task> = {}): Task => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const state = (c: Task): State => ({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const posted = (auto: boolean) => expect.objectContaining({ method: 'POST', body: JSON.stringify({ auto }) });
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('começar sozinho is a switch checked on a task with auto; flipping it posts auto with the new value and keeps the menu open (#164, #542, #573)', async () => {
  const { rerender } = render(<Flow state={state(task())} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  const on = await screen.findByRole('menuitemcheckbox', { name: 'começar sozinho' });
  expect(on).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(on);
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/auto', posted(false)));
  rerender(<Flow state={state(task({ auto: false }))} />);
  const off = screen.getByRole('menuitemcheckbox', { name: 'começar sozinho' });
  expect(off).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(off);
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/auto', posted(true)));
});
