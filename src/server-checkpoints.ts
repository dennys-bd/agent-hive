import type { Express, Request, Response } from 'express';
import { activityParam, taskTarget } from './activity-routes.js';
import { captureCheckpoint, restoreWorktree } from './checkpoints.js';
import { restartPlan } from './restart.js';
import { type LiveView, type Refusal, refuse, type TaskRouteDeps, workspaceOf } from './server-tasks.js';
import { capturable, taskBranch } from './task-runs.js';
import { branchFor, slugFor } from './tasks.js';
import type { Activity, Checkpoint, CheckpointEnd, Task } from './types.js';
import { taskDir, workDir } from './worktree.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const UNKNOWN_CHECKPOINT_MESSAGE = 'ponto de restauração desconhecido';
const NO_WORKTREE_MESSAGE = 'tarefa sem worktree próprio no disco: nada a restaurar';
const CAPTURE_FAILED_MESSAGE = 'o estado atual não pôde ser guardado como ponto de restauração';
const RESTORE_REFUSED_MESSAGE = 'restauração indisponível: uma execução ou outra operação está ativa na tarefa'; // the reducer refused restoring
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
 * or the user's own checkout (#444) captures nothing. A git failure is logged and costs only this restore point, as recordStart's (#283). Answers
 * whether a checkpoint was recorded: a restore stops without it, the other callers go on. */
export async function recordCheckpoint(deps: CheckpointDeps, { repo, activity, task, stage, ended }: CheckpointJob): Promise<boolean> {
  const current = deps.latest()?.activities.find((a) => a.id === activity.id) ?? activity; // the number counts every capture so far
  if (!capturable(current)) return false;
  const n = nextCheckpoint(current.checkpoints);
  try {
    const point = await captureCheckpoint(repo, taskDir(repo, current), current.slug ?? slugFor(task.item), n, deps.exec);
    const checkpoint: Checkpoint = { n, stage, start: startOf(activity, stage, point.head), ...point, at: new Date().toISOString(), ended };
    await deps.dispatch({ type: 'checkpointCaptured', activityId: activity.id, checkpoint });
    return true;
  } catch (err) {
    deps.log.error(`checkpoint #${task.item.id}: ${errorMessage(err)}`);
    return false;
  }
}

// The checkpoint a restore acts on, the task's repo and worktree, the branch it is on and its template (#619), or why not. `n` comes from the URL and
// only ever selects among the numbers the activity keeps: nothing of it reaches git, the checkpoint's own (hex-checked) shas do.
interface RestoreTarget { task: Task; activity: Activity; checkpoint: Checkpoint; repo: string; worktree: string; branch: string; template: string }

function restoreTarget(current: LiveView, activityId: string, n: string): RestoreTarget | Refusal {
  const target = taskTarget(current.state, activityId);
  if ('status' in target) return target;
  const { task, activity } = target;
  const checkpoint = activity.checkpoints?.find((a) => String(a.n) === n);
  if (!checkpoint) return { status: HTTP_NOT_FOUND, message: UNKNOWN_CHECKPOINT_MESSAGE };
  if (!capturable(activity)) return { status: HTTP_CONFLICT, message: NO_WORKTREE_MESSAGE }; // a restore never runs on the workspace's own checkout (#444)
  const workspace = workspaceOf(current.runtime.config, task);
  if ('status' in workspace) return workspace;
  const template = branchFor(current.runtime.config, task.item);
  return { task, activity, checkpoint, repo: workspace.path, worktree: workDir(workspace.path, task, activity), branch: taskBranch(activity, template), template };
}

// The dialog's preview (#619): Restart's plan for the checkpoint's head; git's words as a 409
async function restorePreview(req: Request, res: Response, { requireLive, exec }: TaskRouteDeps): Promise<void> {
  const current = requireLive(res);
  if (!current) return;
  const target = restoreTarget(current, activityParam(req), String(req.params.n));
  if ('status' in target) return refuse(res, target);
  try {
    res.json({ ...(await restartPlan(target.repo, target.branch, target.template, target.checkpoint.head, exec)), branch: target.branch });
  } catch (err) {
    refuse(res, { status: HTTP_CONFLICT, message: errorMessage(err) });
  }
}

// The restore (#619): marked before any git, as Restart's. A task another job already marks is refused before the mark, so this restore never
// drops a mark that is not its own.
async function restoreRun(req: Request, res: Response, deps: TaskRouteDeps): Promise<void> {
  const { requireLive, dispatch, exec, log } = deps;
  const current = requireLive(res);
  if (!current) return;
  const target = restoreTarget(current, activityParam(req), String(req.params.n));
  if ('status' in target) return refuse(res, target);
  const itemId = target.task.item.itemId;
  const busy = { status: HTTP_CONFLICT, message: RESTORE_REFUSED_MESSAGE };
  if (target.activity.deleting) return refuse(res, busy);
  await dispatch({ type: 'restoring', itemId });
  const marked = requireLive(res); // answers its own 409 when the daemon is not live
  if (!marked) return;
  if (!marked.state.activities.find((a) => a.id === target.activity.id)?.deleting) return refuse(res, busy);
  const captured = await recordCheckpoint(deps, { repo: target.repo, activity: target.activity, task: target.task, stage: target.task.stage, ended: 'restore' });
  if (!captured) { // the state this restore would overwrite is not kept: nothing destructive runs (the cause is in hive.log)
    await dispatch({ type: 'restoreFailed', itemId });
    return refuse(res, { status: HTTP_SERVER_ERROR, message: CAPTURE_FAILED_MESSAGE });
  }
  try {
    const plan = await restartPlan(target.repo, target.branch, target.template, target.checkpoint.head, exec);
    await restoreWorktree(target.worktree, target.branch, target.checkpoint, plan, exec);
    await dispatch({ type: 'restored', itemId, ...(plan.mode === 'branch' ? { branch: plan.newBranch } : {}) });
    res.json({ ok: true });
  } catch (err) {
    log.error(`restore #${target.task.item.id} checkpoint ${target.checkpoint.n}: ${errorMessage(err)}`);
    await dispatch({ type: 'restoreFailed', itemId });
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
  }
}

/** Restore (#619): GET is the dialog's preview, Restart's plan for the checkpoint's head (the Hive never rewrites a published branch, #283). POST marks
 * the task, captures the state it leaves as a checkpoint, runs Restart's git to the checkpoint's head and reads its work back unstaged; the task stays in
 * its stage and nothing starts. A git failure drops the mark, reaches hive.log and answers 500 with git's words; the UI shows its own message. */
export function registerCheckpointRoutes(app: Express, deps: TaskRouteDeps): void {
  const path = '/activities/:id/checkpoints/:n/restore';
  app.get(path, (req: Request, res: Response) => restorePreview(req, res, deps));
  app.post(path, (req: Request, res: Response) => restoreRun(req, res, deps));
}
