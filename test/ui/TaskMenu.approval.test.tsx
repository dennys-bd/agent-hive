import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, movedWork, type WithWork } from '../fixtures/work';

// Its own file (#268): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx), so the menu is opened once
// and the awaiting state arrives through rerender; selecting an item closes it for good, so one item is clicked.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}', approval: true }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const workers: Worker[] = [{ id: 's1', status: 'empty' }];
// A free session continued on the task that stopped to wait for the user (#829): the approval is answered there, not from the menu
const waiting: Worker = { id: 's2', status: 'waiting', activityId: activityIdOf('I1'), runId: 'W2', freeSession: true };
const state = (c: WithWork, live: Worker[] = []): State => movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [...workers, ...live], terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('the task menu offers Aprovar and Enviar feedback… only on a task awaiting approval with no session of it live, and Aprovar posts approve (#268, #829)', async () => {
  const onOpen = vi.fn();
  const awaiting = task({ approval: { since: '2026-09-25T10:00:00.000Z' } });
  const { rerender } = render(<Flow state={state(task())} onOpen={onOpen} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'abrir sessão livre…' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'aprovar' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'enviar feedback…' })).not.toBeInTheDocument();
  rerender(<Flow state={state(awaiting, [waiting])} onOpen={onOpen} />);
  expect(screen.queryByRole('menuitem', { name: 'aprovar' })).not.toBeInTheDocument(); // a session of it waits: the user answers there
  expect(screen.queryByRole('menuitem', { name: 'enviar feedback…' })).not.toBeInTheDocument();
  rerender(<Flow state={state(awaiting)} onOpen={onOpen} />);
  expect(screen.getByRole('menuitem', { name: 'enviar feedback…' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'aprovar' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approve', expect.objectContaining({ method: 'POST' })));
  expect(onOpen).not.toHaveBeenCalled(); // a portaled menu click is not a click on the task
});
