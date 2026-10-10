import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file (#430), same reason as TaskMenu.stopAll.test.tsx (#343): Radix's ContextMenu opens once per file under jsdom, so the
// single-run case (no submenu, hence no "dormir todas") needs a file of its own.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true,
  workerId: 's1', sessionId: 'aaaa11112222333344445555',
};
const workers: Worker[] = [{ id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' }];
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 2, workers, terminals: [], stages, tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('a single live session gets a plain dormir item that sleeps at once: no submenu, no dormir todas, no dialog (#430, #672)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  await user.click(await screen.findByRole('menuitem', { name: 'dormir' }));
  expect(screen.queryByRole('menuitem', { name: 'dormir todas' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/ptys/W1/stop', expect.objectContaining({ method: 'POST' })));
});
