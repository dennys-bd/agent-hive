// Where a session can be copied to and how the copy names its ends (#587). Derived from the State the dashboard already receives; nothing of it is stored.
import { activityOf, isLocalActivityId, localWorkspaceOf, recordOf, recordWithSession, taskOfActivity } from '../../activities.js';
import { canOpenSession, taskLabel, resolveWorkspace, SESSION_ID_CHARS } from '../../tasks.js';
import { hasDirectory } from '../../local-sessions.js';
import type { ActivityRecord, Task, Session, SessionRef, SessionTarget, State } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import { activitiesOf, isTask } from './activities.js';

/** A live run, as a tab or a sidebar line knows it. */
export type RunRef = { taskId: string; ptyId: string };
export type CopySource = SessionRef | RunRef;

/** The session a run is running: its worker's id once SessionStart told it, a stage run's activity sessionId before (#629); kept only when a
 * record of the task lists it, which the ref then names. */
export function sessionRefOf(state: State, source: CopySource): SessionRef | undefined {
  if ('sessionId' in source) return source;
  const worker = state.workers.find((s) => s.runId === source.ptyId);
  const id = worker?.sessionId ?? (worker && !worker.freeSession ? activityOf(state, source.taskId)?.sessionId : undefined);
  const record = id === undefined ? undefined : recordWithSession(state, source.taskId, id);
  return record && id !== undefined ? { activityId: record.id, sessionId: id } : undefined;
}

/** The ref of a task's kept session (#629): the record of the task's that lists it, the live one's when none does. */
export const keptRef = (activity: { record: ActivityRecord; records: ActivityRecord[] }, sessionId: string): SessionRef =>
  ({ activityId: (activity.records.find((r) => r.sessions.some((s) => s.id === sessionId)) ?? activity.record).id, sessionId });

export const sessionOf = (state: State, ref: SessionRef): Session | undefined => recordOf(state, ref.activityId)?.sessions.find((s) => s.id === ref.sessionId);

/** A local session's workspace, or the workspace the record's task resolves to. */
export function workspaceOf(state: State, ref: SessionRef): string | undefined {
  const local = localWorkspaceOf(ref.activityId);
  if (local !== undefined) return local;
  const task = taskOfActivity(state, ref.activityId);
  return task && resolveWorkspace(task, state.workspaces, state.sourceWorkspaces);
}

export interface CopyTargets { workspace?: string; local: boolean; activities: Task[] }

/** Where copiar para… offers (A2): the source's workspace only: its local unless the source is that local, then its activities with a directory
 * that a session may open on, in flow order, minus the source's task's. */
export function copyTargets(state: State, ref: SessionRef): CopyTargets {
  const workspace = workspaceOf(state, ref);
  if (workspace === undefined) return { local: false, activities: [] };
  const own = taskOfActivity(state, ref.activityId)?.item.itemId;
  const activities = activitiesOf(state).filter(isTask).filter(({ task, activity }) =>
    resolveWorkspace(task, state.workspaces, state.sourceWorkspaces) === workspace && hasDirectory(activity) && canOpenSession(task, activity)
    && own !== task.item.itemId).map((a) => a.task);
  return { workspace, local: !isLocalActivityId(ref.activityId), activities };
}

/** `#12` / `HIVE-3`: taskLabel without the title. */
export const activityRef = (task: Pick<Task, 'created' | 'item'>): string => `${task.created ? '' : '#'}${task.item.id}`;

export interface CopyLabels { source: string; shortId: string; from: string; to: string; toRef: string }

/** The words the dialog names the two ends with: the session's name or `claude <id>`, the source and the destination in full and short. */
export function copyLabels(state: State, from: SessionRef, to: SessionTarget): CopyLabels {
  const shortId = from.sessionId.slice(0, SESSION_ID_CHARS);
  const local = t('activities.local');
  const source = taskOfActivity(state, from.activityId);
  const target = taskOfActivity(state, to.activityId);
  return {
    source: sessionOf(state, from)?.name ?? `${t('session.claude')} ${shortId}`,
    shortId,
    from: isLocalActivityId(from.activityId) ? local : source ? activityRef(source) : from.activityId,
    to: isLocalActivityId(to.activityId) ? local : target ? taskLabel(target) : to.activityId,
    toRef: isLocalActivityId(to.activityId) ? local : target ? activityRef(target) : to.activityId,
  };
}

/** Why nova atividade…'s activity can't take the copy (Planning default 5), or undefined. */
export function copyRefusal(state: State, from: SessionRef, taskId: string): MessageKey | undefined {
  if (taskOfActivity(state, from.activityId)?.item.itemId === taskId) return 'copy.sameActivity';
  const task = state.tasks.find((c) => c.item.itemId === taskId);
  const workspace = task && resolveWorkspace(task, state.workspaces, state.sourceWorkspaces);
  return workspace !== undefined && workspace === workspaceOf(state, from) ? undefined : 'copy.otherWorkspace';
}

/** A session's routes (#629): under its record's id, a deleted activity's or a local one's too. */
export const sessionPath = (ref: SessionRef): string => `/activities/${encodeURIComponent(ref.activityId)}/sessions/${encodeURIComponent(ref.sessionId)}`;

export const copyQuery = (to: SessionTarget): string => `toActivity=${encodeURIComponent(to.activityId)}`;
