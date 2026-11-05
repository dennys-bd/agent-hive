// Out of the flow by hand (#566): the stage and everything that only means something inside one go; the activity, its worktree, sessions,
// error and stage start stay. Out of orchestrator.ts, past 400 lines. Pure.
import { activityOf, withActivity } from './activities.js';
import { none, type Reduced, withTask } from './reducer-kit.js';
import { canDismissError, inFlow, leave, taskId } from './tasks.js';
import type { Activity, State, Task } from './types.js';

/** Why leave-flow may not run (#566), in the order the route answers. The reducer and the route share it, so they never disagree. */
export type LeaveBlocker = 'outside' | 'epic' | 'deleting' | 'running';

export function leaveBlocker(state: State, task: Task): LeaveBlocker | undefined {
  if (!inFlow(task)) return 'outside';
  if (task.item.epic !== undefined) return 'epic'; // followEpics would put it back in a stage on the next event
  if (activityOf(state, taskId(task))?.deleting) return 'deleting';
  return canDismissError(task, state) ? undefined : 'running'; // canMoveToStage's refusal, the epic already answered
}

// The tries and the arrow, an awaited approval (dropped, not refused: no transition is left for approve or feedback to fire) and a pending handoff
const outOfStage = ({ tries: _t, tryLog: _l, via: _v, approval: _a, handoffPending: _p, handoffFeedback: _f, ...kept }: Activity): Activity => kept;

export function leaveFlow(state: State, id: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  if (task === undefined || leaveBlocker(state, task) !== undefined) return none(state); // a stale event, as a stale move is
  const left = withTask(state, { ...leave(task), placedByHand: true }); // #670: the hand wins over the entry property
  const live = activityOf(left, id);
  return none(live === undefined ? left : withActivity(left, outOfStage(live)));
}
