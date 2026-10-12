import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file (#343): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx).
const stages: Stage[] = [{ name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: false }];
const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'ci', boardColumn: 'CI', auto: true,
  ci: { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: [] },
};
const state = (): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click › dormir on a task waiting for CI, with no live run, ends the wait through its own route (#834)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state()} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  await user.click(await screen.findByRole('menuitem', { name: 'dormir' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/activities/${activityIdOf('I1')}/ci/stop`, expect.objectContaining({ method: 'POST' })));
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/^\/ptys\//), expect.anything());
});
