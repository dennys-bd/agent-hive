// The auto badge's look (#735, #727): the task's own auto is on, but the Hive stopped it; only a start, a continue, a stage change or turning the auto back on (#892) brings it back.
import { activityOf } from '../../activities.js';
import type { State, Task } from '../../types.js';

/** The struck badge: the auto is still set, just not in force. */
export const STOPPED_BADGE = 'opacity-50 line-through';

/** A task's auto badge class (#727): struck while its activity is stopped, plain otherwise. */
export const taskAutoBadge = (task: Task, state: Pick<State, 'activities' | 'activityRecords'>): string =>
  (activityOf(state, task.item.itemId)?.stopped ? STOPPED_BADGE : '');
