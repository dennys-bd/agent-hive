import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { copyLabels, copyRefusal, copyTargets, sessionRefOf } from '@/lib/copy-targets';
import type { ActivityRecord, Task, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const task = (itemId: string, id: string, project: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId, id, title: `task ${id}`, body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true, workspace: project, worktree: `/w/${id}`, branch: `hive/${id}`, ...extra,
});
const ONE = task('local:1', 'HIVE-1', 'hive', { created: true });
// ONE's session, in its record (#629)
const ONE_RECORD: ActivityRecord = { id: 'a-local:1', taskIds: ['local:1'], sessions: [{ id: S, startedAt: '', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '', name: 'revisão' }] };
const LOCAL_HIVE: ActivityRecord = { id: 'local:hive', taskIds: [], sessions: [{ id: S, startedAt: '', stages: [], agent: 'claude' as const, lastUsedAt: '' }] };
const state = (tasks: Task[], workers: Worker[] = [], activityRecords: ActivityRecord[] = [ONE_RECORD]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages: [], tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive', 'site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
beforeEach(() => setLanguage('pt'));

test('copyTargets offers the source\'s workspace only: its local, then its other activities with a directory in board order; not the source, not a gone worktree, not another workspace (#587)', () => {
  const s = state([ONE, task('I2', '2', 'hive'), task('I3', '3', 'site'), task('I4', '4', 'hive', { worktreeGone: true }), task('I5', '5', 'hive', { worktree: undefined })]);
  const targets = copyTargets(s, { activityId: 'a-local:1', sessionId: S });
  expect([targets.workspace, targets.local, targets.activities.map((c) => c.item.itemId)]).toEqual(['hive', true, ['I2']]);
  expect(copyTargets({ ...s, activityRecords: [ONE_RECORD, LOCAL_HIVE] }, { activityId: 'local:hive', sessionId: S }).local).toBe(false);
});

test('sessionRefOf reads a run\'s session from its worker, a stage run\'s from the task before SessionStart; copyLabels and copyRefusal name the ends (#587)', () => {
  const s = state([ONE, task('I2', '2', 'hive'), task('I3', '3', 'site')], [{ id: 'x', status: 'working', runId: 'W1', activityId: activityIdOf('local:1'), sessionId: S, freeSession: true }]);
  expect(sessionRefOf(s, { taskId: 'local:1', ptyId: 'W1' })).toEqual({ activityId: 'a-local:1', sessionId: S });
  expect(sessionRefOf(s, { taskId: 'local:1', ptyId: 'nope' })).toBeUndefined();
  expect(copyLabels(s, { activityId: 'a-local:1', sessionId: S }, { activityId: 'local:hive' })).toEqual({ source: 'revisão', agent: 'claude', shortId: 'a1b2c3d4', from: 'HIVE-1', to: 'local', toRef: 'local' });
  expect(copyLabels(s, { activityId: 'a-local:1', sessionId: S }, { activityId: activityIdOf('I2') })).toMatchObject({ to: '#2 task 2', toRef: '#2' });
  expect([copyRefusal(s, { activityId: 'a-local:1', sessionId: S }, 'local:1'), copyRefusal(s, { activityId: 'a-local:1', sessionId: S }, 'I3'), copyRefusal(s, { activityId: 'a-local:1', sessionId: S }, 'I2')])
    .toEqual(['copy.sameActivity', 'copy.otherWorkspace', undefined]);
});

test('a stage run\'s session is the task\'s before SessionStart; a session the task does not list is none; a local session\'s labels and paths (#587)', () => {
  const staged = { ...ONE, sessionId: S };
  const s = state([staged], [{ id: 'x', status: 'working', runId: 'W1', activityId: activityIdOf('local:1') }]);
  expect(sessionRefOf(s, { taskId: 'local:1', ptyId: 'W1' })).toEqual({ activityId: 'a-local:1', sessionId: S });
  const other = state([ONE], [{ id: 'x', status: 'working', runId: 'W1', activityId: activityIdOf('local:1'), sessionId: S, freeSession: true }], [{ ...ONE_RECORD, sessions: [] }]);
  expect(sessionRefOf(other, { taskId: 'local:1', ptyId: 'W1' })).toBeUndefined();
  const local = { ...s, activityRecords: [ONE_RECORD, LOCAL_HIVE] };
  expect(copyLabels(local, { activityId: 'local:hive', sessionId: S }, { activityId: 'a-local:1' })).toMatchObject({ source: `claude ${S.slice(0, 8)}`, from: 'local', toRef: 'HIVE-1' });
});
