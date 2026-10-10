import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file (#343, #542): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx), so the menu is opened once
// and every state below arrives through rerender; the one confirm click at the end closes it for good.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const state = (c: WithWork, workers: Worker[]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click › dormir is absent with no live agent session, a plain item on one, which sleeps that run at once with no dialog (#343, #672)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Flow state={state(task(), [])} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'abrir sessão livre…' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'dormir' })).not.toBeInTheDocument();
  rerender(<Flow state={withPointedWork({ ...state(task(), []), terminals: [{ terminalId: 'T1', activityId: activityIdOf('I1'), startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo' }] })} />); // pointed: the terminal's activity exists
  expect(screen.queryByRole('menuitem', { name: 'dormir' })).not.toBeInTheDocument(); // a terminal is no session
  expect(screen.getByRole('menuitem', { name: 'dormir todas' })).toBeInTheDocument(); // #696: a live terminal sleeps with dormir todas

  rerender(<Flow state={state(task({ workerId: 's1' }), [{ id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' }])} />);
  await user.click(screen.getByRole('menuitem', { name: 'dormir' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/ptys/W1/stop', expect.objectContaining({ method: 'POST' })));
});
