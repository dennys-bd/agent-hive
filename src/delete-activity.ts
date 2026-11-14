import { withActivity } from './activities.js';
import { ensureActivity, type Reduced, sourceWrites, withTask } from './reducer-kit.js';
import { closeTerminals } from './runs.js';
import { nothingToDelete, onSource, stageOf } from './tasks.js';
import { advance } from './transit.js';
import type { Activity, State, Task } from './types.js';

// The delete-activity stage's start (#236, #573), out of orchestrator.ts so the epic pass starts an epic's through the same path (#856):
// orchestrator.ts imports epic-follow.ts, so the pass cannot import it back.

/** The delete-activity stage acts: its onStart list written in order (as occupy does, #515), then the effect, with the scope it removes
 * (#236). No worker, no signal, no budget: a git command of the Hive, not a Claude session. `deleting` marks the task until the answer, so a
 * poll, a stage edit or a second start overlapping a slow remove never emits a second deletion for it. With nothing the scope covers on the
 * task (#236) there is no effect and no mark: the task moves on at once. */
export function startDeleteActivity(given: State, task: Task): Reduced {
  // #629: a task with no activity but kept sessions in scope deletes through a fresh one, as main's delete saw them on the task
  const born = nothingToDelete(given, task, given.deleteActivity) ? undefined : ensureActivity(given, task);
  if (!born) { // #236: nothing the scope covers is on the task, so the stage only moves it on
    const { state: advanced, effects } = advance(given, task, { trigger: 'done' }); // #134: a delete activity ends with done
    return { state: advanced, effects };
  }
  const { state, activity } = born;
  const written = sourceWrites(task, onSource(stageOf(state.stages, task.stage)?.onStart, task.item.source));
  const started = written.task;
  const marked: Activity = { ...activity, deleting: true };
  const closed = closeTerminals(state, task); // its terminals first (#573): git never runs under one
  return {
    state: withActivity(withTask(closed.state, started), marked),
    effects: [...closed.effects, ...written.effects, { type: 'deleteActivity', activity: marked, task: started, scope: state.deleteActivity }],
  };
}
