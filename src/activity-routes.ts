import type { Request } from 'express';
import { recordOf, taskOfActivity } from './activities.js';
import type { Refusal } from './server-tasks.js';
import type { Activity, ActivityRecord, State, Task } from './types.js';

// What `:id` names on /activities/:id/* (#629): a live activity for every route on the work, any record for a session's open, clear and copy,
// so a deleted activity's kept sessions still work as they did on the task. Checked first, before any body.

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
export const UNKNOWN_ACTIVITY_MESSAGE = 'atividade desconhecida';
/** A route that acts on a task's work, asked of a workspace's local activity, which has no task. */
export const LOCAL_ACTIVITY_MESSAGE = 'atividade local não tem tarefa';

const unknown: Refusal = { status: HTTP_NOT_FOUND, message: UNKNOWN_ACTIVITY_MESSAGE };

/** The `:id` of an /activities/:id/* route. */
export const activityParam = (req: Request): string => String(req.params.id);

/** A live activity, its record and, on a task's activity, its task; 404 on an unknown or deleted id. */
export function liveTarget(state: State, id: string): { activity: Activity; record: ActivityRecord; task?: Task } | Refusal {
  const activity = state.activities.find((a) => a.id === id);
  const record = activity && recordOf(state, id);
  if (!activity || !record) return unknown;
  const task = taskOfActivity(state, id);
  return activity.kind === 'task' && !task ? unknown : { activity, record, ...(task ? { task } : {}) };
}

/** A live task activity with its task: what the routes on a task's work (continue, restart, approval, delete, diff, tree, files) act on. A
 * local activity answers 409, an unknown or deleted id 404. */
export function taskTarget(state: State, id: string): { activity: Activity; record: ActivityRecord; task: Task } | Refusal {
  const target = liveTarget(state, id);
  if ('status' in target) return target;
  const { task } = target;
  return task ? { ...target, task } : { status: HTTP_CONFLICT, message: LOCAL_ACTIVITY_MESSAGE };
}

/** Any record, a deleted activity's too, with its live activity when it has one and the task it lists first; 404 on an unknown id. */
export function keptTarget(state: State, id: string): { record: ActivityRecord; activity?: Activity; task?: Task } | Refusal {
  const record = recordOf(state, id);
  if (!record) return unknown;
  const activity = state.activities.find((a) => a.id === id);
  const task = taskOfActivity(state, id);
  return { record, ...(activity ? { activity } : {}), ...(task ? { task } : {}) };
}
