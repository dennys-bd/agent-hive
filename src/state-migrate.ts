import { randomUUID } from 'node:crypto';
import { isUuid } from './orchestrator.js';
import { localActivityId } from './activities.js';
import { LEGACY_RUN_AGENT } from './agents.js';
import { isJsonObject, SLUG, savedRecordFields, savedSession, savedWork } from './state-guards.js';
import { resolveWorkspace, type WorkspaceNames } from './tasks.js';
import type { Activity, ActivityRecord, Session, State, Task } from './types.js';

// #629's load migration: a state.json written before it has no `activities` key and every task carries its own work. A boot must not lose a
// running worktree, a session, a run or a pending approval, so each comes back as the task's activity and record.

// Any of these on a saved task: its activity was still live
const LIVE_KEYS = ['worktree', 'workerId', 'inFlight', 'stopped', 'stageStart', 'approval', 'feedback', 'error'];
// Any of these with no live key: an activity the user deleted, whose record the task still reads
const KEPT_KEYS = ['sessions', 'sessionId', 'result', 'prs', 'prUrl', 'usage'];

const has = (saved: Record<string, unknown>, keys: string[]): boolean => keys.some((key) => saved[key] !== undefined);

// The record's fields, a lone sessionId read as the one session sessionsOf made of it (#164), every session moved to the main repo when the
// activity was deleted (#208)
function recordFields(saved: Record<string, unknown>, task: Task, repo: boolean): Omit<ActivityRecord, 'id' | 'taskIds'> {
  const fields = savedRecordFields(saved);
  const lone: Session[] = fields.sessions.length === 0 && !Array.isArray(saved.sessions) && isUuid(saved.sessionId)
    ? [{ id: saved.sessionId, startedAt: task.enteredAt ?? '', stages: [task.stage], lastUsedAt: task.enteredAt ?? '', agent: LEGACY_RUN_AGENT }] : [];
  const sessions = fields.sessions.length > 0 ? fields.sessions : lone;
  return { ...fields, sessions: repo ? sessions.map((s): Session => ({ ...s, repo: true })) : sessions };
}

// One task's work: both records while its activity was live and it resolves to a workspace, a record alone once it was deleted (its local, base
// and sessionId dropped: a later start chooses again), nothing for a task with none of it
function workOf(saved: Record<string, unknown>, task: Task, scope: WorkspaceNames, tasks: readonly Task[]): { activity?: Activity; record?: ActivityRecord } {
  const id = randomUUID();
  const taskIds = [task.item.itemId];
  const workspace = resolveWorkspace(task, scope.workspaces, scope.sourceWorkspaces, tasks);
  const slug = typeof saved.slug === 'string' && SLUG.test(saved.slug) ? saved.slug : undefined;
  if (has(saved, LIVE_KEYS) && workspace !== undefined && slug !== undefined) {
    return { activity: { id, kind: 'task', workspace, slug, ...savedWork(saved) }, record: { id, taskIds, ...recordFields(saved, task, false) } };
  }
  return has(saved, LIVE_KEYS) || has(saved, KEPT_KEYS) ? { record: { id, taskIds, ...recordFields(saved, task, true) } } : {};
}

/** Steps 1 to 3 of the spec's migration, over the saved tasks (raw, as they passed isTask) and the same tasks normalized. */
export function migrateWork(saved: Record<string, unknown>[], tasks: Task[], scope: WorkspaceNames): Pick<State, 'activities' | 'activityRecords'> {
  const raw = new Map(saved.flatMap((s) => (isJsonObject(s.item) && typeof s.item.itemId === 'string' ? [[s.item.itemId, s] as const] : [])));
  const work = tasks.map((task) => workOf(raw.get(task.item.itemId) ?? {}, task, scope, tasks));
  return { activities: work.flatMap((w) => w.activity ?? []), activityRecords: work.flatMap((w) => w.record ?? []) };
}

// The keys #629 moved off Task: dropped from every task on load, so the next save writes none of them.
export const MOVED_TASK_KEYS = [
  'sessions', 'result', 'prs', 'prUrl', 'usage', 'slug', 'worktree', 'branch', 'worktreeGone', 'local', 'base', 'setup', 'deleting', 'checkout',
  'sessionId', 'workerId', 'inFlight', 'stopped', 'stoppedAt', 'stageStart', 'error', 'approval', 'feedback',
];

/** Step 4: every workspace the file names gets its local activity, its record holding that workspace's saved local sessions (#587). */
export function migrateLocals(raw: unknown, workspaces: string[]): Pick<State, 'activities' | 'activityRecords'> {
  const saved = isJsonObject(raw) ? raw : {};
  return {
    activities: workspaces.map((workspace): Activity => ({ id: localActivityId(workspace), kind: 'local', workspace })),
    activityRecords: workspaces.map((workspace): ActivityRecord => {
      const list = Object.hasOwn(saved, workspace) ? saved[workspace] : undefined;
      return { id: localActivityId(workspace), taskIds: [], sessions: Array.isArray(list) ? list.flatMap(savedSession).map((s) => ({ ...s, stages: [] })) : [] };
    }),
  };
}

/** Step 5: a saved worker's taskId or local workspace mapped to its activity's id, before normalizeWorker reads it; an occupied worker that
 * maps to none is emptied, as an unknown one is (normalizeWorker), so the worker count the cap reads stays. A workspace counts only on a local
 * session's run, a free session with no taskId, as normalizeWorker read it before #629 (#590). */
export function migrateWorker(saved: unknown, work: Pick<State, 'activities' | 'activityRecords'>): unknown {
  if (!isJsonObject(saved)) return saved;
  const { taskId, workspace, ...rest } = saved;
  const record = typeof taskId === 'string' ? work.activityRecords.find((r) => r.taskIds.includes(taskId) && work.activities.some((a) => a.id === r.id)) : undefined;
  const isLocalRun = typeof workspace === 'string' && rest.freeSession === true && taskId === undefined;
  const local = isLocalRun && work.activities.some((a) => a.id === localActivityId(workspace)) ? localActivityId(workspace) : undefined;
  const activityId = record?.id ?? local;
  if (activityId !== undefined) return { ...rest, activityId };
  return rest.status === 'empty' ? rest : { id: rest.id, status: 'empty' };
}
