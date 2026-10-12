import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file (#343): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx); the top menu opens once,
// its dormir submenu is a nested layer that stays reachable until a leaf item is picked, which happens once at the end (dormir todas).
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true,
  workerId: 's1', sessionId: 'aaaa11112222333344445555',
};
const workers: Worker[] = [
  { id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' },
  { id: 'm1', status: 'working', activityId: activityIdOf('I1'), runId: 'W2', freeSession: true, sessionId: 'bbbb22223333444455556666' },
];
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 2, workers, terminals: [], stages, tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('two live sessions turn dormir into a submenu listing each plus dormir todas; dormir todas confirms in its dialog and posts one sleep for both (#343, #672)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  await user.click(await screen.findByRole('menuitem', { name: 'dormir' }));
  expect(await screen.findByRole('menuitem', { name: 'Claude · aaaa1111' })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Claude · bbbb2222' })).toBeInTheDocument();
  const all = screen.getByRole('menuitem', { name: 'dormir todas' });
  expect(all.className).not.toContain('text-destructive');
  expect(all.previousElementSibling).toHaveAttribute('data-slot', 'context-menu-separator');
  fireEvent.click(all);
  const dialog = await screen.findByRole('dialog', { name: 'Dormir #1 Task 1?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'dormir todas' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/ptys/sleep', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ptyIds: ['W1', 'W2'] }) })));
});
