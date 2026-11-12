import { activityOf, taskOfActivity, workersIn } from './activities.js';
import { removalBlocker, taskId, taskLabel } from './tasks.js';
import type { Activity, HeldActivity, HoldingBlocker, State, Task } from './types.js';

// What a saved workspace still holds (#750), for the removal dialog of #751. The state's part is pure; the route (below) adds git's.

type HeldState = Pick<State, 'tasks' | 'workers' | 'stages' | 'deleteActivity' | 'activities' | 'activityRecords'>;

// Decision 5: a run or a deletion in flight is the stronger reason; a local activity has no worktree, so removalBlocker would call it
// nothingToDelete, and local says why truly
function holdingBlocker(task: Task, activity: Activity, state: HeldState): HoldingBlocker | undefined {
  const blocker = removalBlocker(task, state);
  if (blocker === 'running' || blocker === 'deleting') return blocker;
  return activity.local ? 'local' : blocker;
}

/** The workspace's task activities that have a task (decision 4): Activity.workspace is frozen at creation, so it is where the activity lives
 * even after a rule moved the task. A kept activity is cleaned through its worktree row, as the worktrees tab does. */
export function heldActivities(state: HeldState, name: string): HeldActivity[] {
  return state.activities.flatMap((activity): HeldActivity[] => {
    const task = activity.kind === 'task' && activity.workspace === name ? taskOfActivity(state, activity.id) : undefined;
    if (task === undefined) return [];
    const held = { activityId: activity.id, task: { id: taskId(task), title: taskLabel(task) } };
    const reason = holdingBlocker(task, activity, state);
    const entry: HeldActivity = reason === undefined ? { ...held, removable: true } : { ...held, removable: false, reason };
    return [entry];
  });
}

/** The tasks with no activity whose own workspace is the name (decision 6): one a rule places resolves again once the workspace is gone. */
export const heldTasks = (state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, name: string): { id: string; title: string }[] =>
  state.tasks.filter((task) => task.workspace === name && activityOf(state, taskId(task)) === undefined).map((task) => ({ id: taskId(task), title: taskLabel(task) }));

/** A worker runs in one of the workspace's activities (decision 3), its local one included: the dialog never offers a removal meanwhile. */
export const isRunningIn = (state: Pick<State, 'workers' | 'activities'>, name: string): boolean =>
  state.activities.some((activity) => activity.workspace === name && workersIn(state.workers, activity.id).length > 0);
