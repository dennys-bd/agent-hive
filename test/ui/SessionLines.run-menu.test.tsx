import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ActivitiesPanel } from '@/components/ActivitiesPanel';
import { CopySessionHost } from '@/components/CopySession';
import { setLanguage } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, taskPairOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom
const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive', worktree: '/w/1' };
const records = [{ id: 'a-I1', taskIds: ['I1'], sessions: [{ id: S, startedAt: '', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '' }] }]; // #629: the task's session is its record's
const run = { ptyId: 'W3', label: 'Claude · a1b2c3d4', kind: 'session' as const, session: 'a1b2c3d4' };
const activity: TaskActivity = { kind: 'task', ...taskPairOf('I1', {}, records[0]), task, runs: [run], sessions: [{ run, status: 'working' }], status: 'working', worker: false, records };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [{ id: 's', status: 'working', runId: 'W3', activityId: activityIdOf('I1'), sessionId: S, freeSession: true }], terminals: [], stages: [], tasks: [task], sourceOrder: [],
  localCount: 0, activities: [], activityRecords: records, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))); });

test('right-click on a session line: copiar para… ›, then dormir, which sleeps the run at once, with no dialog (#587, #672)', async () => {
  render(
    <CopySessionHost state={state}>
      <ActivitiesPanel activities={[activity]} workspaces={['hive']} stages={[]} workers={state.workers} onSelect={vi.fn()} onOpenRun={vi.fn()} nav={{ newActivity: vi.fn() }} />
    </CopySessionHost>,
  );
  fireEvent.contextMenu(screen.getByRole('button', { name: /^claude/ }));
  expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['copiar para…', 'dormir']);
  expect(screen.getByRole('menuitem', { name: 'dormir' })).not.toHaveClass('text-destructive');
  fireEvent.click(screen.getByRole('menuitem', { name: 'dormir' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/ptys/W3/stop', expect.objectContaining({ method: 'POST' })));
});
