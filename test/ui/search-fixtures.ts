// Shared by the search's tests (#584): a State, a task, the navigation spies and a context. Not a test file: vitest collects *.test.tsx only.
import { vi } from 'vitest';
import type { OperationContext, SearchNav } from '@/lib/operations';
import type { ActivityRecord, Task, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withLocalActivities } from '../../src/activities';
import { movedWork, withPointedWork, type WithWork } from '../fixtures/work';

export const STAGES: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];

export const task = (id: string, title: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title, body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});

/** Task `itemId`'s record (#629): the sessions and PRs a fixture task had on itself. */
export const recordFor = (itemId: string, made: Partial<Omit<ActivityRecord, 'id' | 'taskIds'>>): ActivityRecord => ({ id: `a-${itemId}`, taskIds: [itemId], sessions: [], ...made });

export const stateOf = (tasks: Task[], extra: Partial<State> = {}): State => withLocalActivities(movedWork(withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: STAGES, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [],
  disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT,
  approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, ...extra,
}))); // #629: each run's activity and record, the worktree fields on each task's activity, and each workspace's local pair

export const navOf = (): SearchNav => ({
  openActivity: vi.fn(), showFlow: vi.fn(), startTask: vi.fn(), dialog: vi.fn(), openRun: vi.fn(), openDiff: vi.fn(), openPr: vi.fn(), openConsole: vi.fn(), openStarted: vi.fn(), closeTab: vi.fn(),
  openPreview: vi.fn(), openChanges: vi.fn(),
});

export const ctxOf = (state: State, extra: Partial<OperationContext> = {}): OperationContext => ({ state, nav: navOf(), ...extra });
