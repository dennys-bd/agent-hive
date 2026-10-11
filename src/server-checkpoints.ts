import { captureCheckpoint } from './checkpoints.js';
import type { TaskRouteDeps } from './server-tasks.js';
import { capturable } from './task-runs.js';
import { slugFor } from './tasks.js';
import type { Activity, Checkpoint, CheckpointEnd, Task } from './types.js';
import { taskDir } from './worktree.js';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a capture needs (#619): git, the log, the dispatch, and the state as it is now, for the next number. */
export type CheckpointDeps = Pick<TaskRouteDeps, 'exec' | 'log' | 'dispatch' | 'latest'>;
/** One capture (#619): the task's repo, its activity as the caller saw it, the stage the checkpoint ran in and how it ended. */
export interface CheckpointJob { repo: string; activity: Activity; task: Task; stage: string; ended: CheckpointEnd }

/** The next checkpoint's number (#619): one past the highest the activity keeps, 1 for its first. */
export const nextCheckpoint = (checkpoints: readonly Checkpoint[] = []): number => checkpoints.reduce((max, a) => Math.max(max, a.n), 0) + 1;

// Where the checkpoint started (#619): the stage's recorded start, read off the caller's activity (a stage end's effect carries it from before the
// end cleared it); the checkpoint's own head when the stage recorded none
const startOf = (activity: Activity, stage: string, head: string): string => (activity.stageStart?.stage === stage ? activity.stageStart.commit : head);

/** Captures the task's worktree as a checkpoint and records it (#619): a stage end's effect, Restart's route and a restore's. A worktree not on disk
 * or the user's own checkout (#444) captures nothing. A git failure is logged and costs only this restore point, as recordStart's (#283). */
export async function recordCheckpoint(deps: CheckpointDeps, { repo, activity, task, stage, ended }: CheckpointJob): Promise<void> {
  const current = deps.latest()?.activities.find((a) => a.id === activity.id) ?? activity; // the number counts every capture so far
  if (!capturable(current)) return;
  const n = nextCheckpoint(current.checkpoints);
  try {
    const point = await captureCheckpoint(repo, taskDir(repo, current), current.slug ?? slugFor(task.item), n, deps.exec);
    const checkpoint: Checkpoint = { n, stage, start: startOf(activity, stage, point.head), ...point, at: new Date().toISOString(), ended };
    await deps.dispatch({ type: 'checkpointCaptured', activityId: activity.id, checkpoint });
  } catch (err) {
    deps.log.error(`checkpoint #${task.item.id}: ${errorMessage(err)}`);
  }
}
