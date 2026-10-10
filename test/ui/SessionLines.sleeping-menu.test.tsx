import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ActivitiesPanel } from '@/components/ActivitiesPanel';
import { CopySessionHost } from '@/components/CopySession';
import { setLanguage } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import type { Session, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { taskPairOf, type WithWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom
const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const session: Session = { id: S, startedAt: '', stages: ['dev'], lastUsedAt: '' };
const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive', worktree: '/w/1' };
const records = [{ id: 'a-I1', taskIds: ['I1'], sessions: [session] }]; // #629: the task's session is its record's
const activity: TaskActivity = { kind: 'task', ...taskPairOf('I1', {}, records[0]), task, runs: [], sessions: [{ session, status: 'empty' }], status: 'empty', worker: false, records };
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [], tasks: [task], sourceOrder: [],
  localCount: 0, activities: [], activityRecords: records, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('right-click on a sleeping task line: copiar para… ›, then limpar in the destructive colour, which posts the task\'s clear (#614)', async () => {
  render(
    <CopySessionHost state={state}>
      <ActivitiesPanel activities={[activity]} workspaces={['hive']} stages={[]} workers={[]} onSelect={vi.fn()} onOpenRun={vi.fn()} nav={{ newActivity: vi.fn() }} />
    </CopySessionHost>,
  );
  fireEvent.contextMenu(screen.getByRole('button', { name: /^claude/ }));
  expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['copiar para…', 'limpar']);
  expect(screen.getByRole('menuitem', { name: 'limpar' })).toHaveClass('text-destructive');
  fireEvent.click(screen.getByRole('menuitem', { name: 'limpar' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/activities/a-I1/sessions/${S}/clear`, expect.objectContaining({ method: 'POST' })));
});
