import type { Task } from '../../../types';
import { postJson, WriteCancelled } from '../../lib/api.js';

// Resolves to undefined when the route accepts, else to the route's own message: the dialog shows it inline, so no toast.
// A cancelled intervention (#469) is the user's choice: it resolves to an empty message, which is neither success nor something to show.
function post(path: string, body?: unknown): Promise<string | undefined> {
  return postJson<unknown>(path, body).then(() => undefined, (err: Error) => (err instanceof WriteCancelled ? '' : err.message));
}

const taskPath = (task: Task, route: string): string => `/tasks/${encodeURIComponent(task.item.itemId)}/${route}`;

/** Takes a task outside the flow to `stage` of a flow (#579). */
export const takeToFlow = (task: Task, stage: string): Promise<string | undefined> => post(taskPath(task, 'move-to'), { stage });

/** Takes a task out of its flow (#566). */
export const leaveFlow = (task: Task): Promise<string | undefined> => post(taskPath(task, 'leave-flow'));
