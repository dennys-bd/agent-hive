// The deletion of an activity, out of server-tasks.ts (#159): what it runs on disk, the delete-activity route and the close's worktree removal.
import type { Express, Request, Response } from 'express';
import { recordOf, activityOf } from './activities.js';
import { activityParam, taskTarget } from './activity-routes.js';
import { branchFor, nothingToDelete, sessionsOf, slugFor } from './tasks.js';
import { LOCAL_MESSAGE } from './server-local.js';
import { refuse, removalRefusal, workspaceOf, type LiveView, type Refusal, type TaskRouteDeps } from './server-tasks.js';
import type { Activity, DeleteActivityScope, Session, Task, TaskPr, Workspace } from './types.js';
import type { MachineFor } from './machine.js';
import { dropCheckpoints } from './checkpoints.js';
import { dropBranches, dropStageStart, leftBehind } from './restart.js';
import { taskDir, wordsOf } from './worktree.js';
import { cleanWorktree, refuseUnmerged, removeWorktree } from './worktree-remove.js';
import { refusalOf, RemovalRefusal, UNEXPECTED } from './worktree-base.js';
import type { Logger } from './log.js';
import { teardownRunId } from './console.js';
import { removeInRun, type WorktreeRunDeps } from './task-setup.js';
import { removeTranscripts } from './transcript.js';
import { isStranded, strandedTranscripts, strandedWorkspace } from './worktree-stranded.js';

const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;

// #660: act toasts the 409's message, so a known refusal answers its own sentence and git's words, for anything else, go to hive.log only
const CLOSE_UNEXPECTED = 'Unexpected error';
function closeFailure(err: unknown, log: Pick<Logger, 'error'>, id: string): string {
  if (err instanceof RemovalRefusal) return err.message;
  log.error(`close #${id}: ${wordsOf(err)}`);
  return CLOSE_UNEXPECTED;
}

/** excluir task… (#542): a local task with a worktree loses it and its branch before it leaves the Hive, through the removal the
 * delete-activity route runs; both always go, as the glossary's delete activity says, the sessions and transcripts per the delete-activity scope.
 * deletingTask's mark holds the fill off while git runs, and taskDeleted drops the task in the reduction that drops the mark, so no fill in
 * between can hand it a worker: 'deleted', the close is done. deletingTask closes its terminals first (#573): git never runs under one.
 * A git refusal is the 409 with its sentence, any other failure the 409 with "Unexpected error" and git's words in hive.log; the task stays. Any other task has nothing to remove: undefined. */
export async function removeCreatedWorktree(deps: TaskRouteDeps, current: LiveView, taskId: string): Promise<Refusal | 'deleted' | undefined> {
  const task = current.state.tasks.find((c) => c.item.itemId === taskId);
  const activity = activityOf(current.state, taskId);
  if (!task?.created || activity?.worktree === undefined || activity.local) return undefined;
  const stranded = isStranded(current.runtime.config, activity); // #746: its workspace left the Comb
  const own = stranded ? undefined : workspaceOf(current.runtime.config, task, current.state.tasks);
  if (own && 'status' in own) return own;
  const scope = current.state.deleteActivity; // the worktree and its branch always go (#573)
  await deps.dispatch({ type: 'deletingTask', taskId });
  try {
    const sessions = sessionsOf(current.state, task.item.itemId);
    const workspace = stranded ? await strandedWorkspace(activity, task, deps.machineFor(activity).exec) : own;
    if (workspace) await deleteActivityOnDisk({ workspace, activity, task, sessions, prs: recordOf(current.state, activity.id)?.prs ?? [], branch: branchFor(current.runtime.config, task.item), scope }, deps);
    else await strandedTranscripts(activity, task, sessions, scope, deps.log); // nothing on disk to remove: only the transcripts under the path's own repo
  } catch (err) {
    await deps.dispatch({ type: 'activityKept', activityId: activity.id });
    return { status: HTTP_CONFLICT, message: closeFailure(err, deps.log, task.item.id) };
  }
  await deps.dispatch({ type: 'taskDeleted', taskId });
  return 'deleted';
}

/** What deleteActivityOnDisk needs (#654): the log, what opens the teardown's console run, and the activity's machine (#159). */
export type DeleteActivityDeps = WorktreeRunDeps & { log: Pick<Logger, 'debug' | 'error' | 'info'>; machineFor: MachineFor };

/** What deleting a task's activity runs on disk (#236, #573, #654): git first, always the worktree and its branch, all or nothing as cleanWorktree
 * is, with the workspace's teardown between git's checks and the removal (a failing step refuses as git does), or the forced removeWorktree,
 * which runs no teardown; a Restart's left-behind branches and the stage-start ref (#283) after it. Then, once git is through, the transcripts
 * when the scope covers them. A refusal rejects before any transcript goes; a transcript that cannot be deleted is logged and the deletion
 * still counts as done. The teardown is a run of the setup channel labelled by the task. The stage's effect (server.ts), the ⋯ menu's item
 * and excluir task… (#542) share it. A local task (#444) runs no git and no teardown: its branch is usually the one the user's checkout
 * holds, which `branch -d` refuses. */
export async function deleteActivityOnDisk(
  // sessions: every record's of the task (#629), since a git job holds no state; prs (#660): the live activity record's, which mergedByPr reads for a branch git calls unmerged
  job: { workspace: Workspace; activity: Activity; task: Task; sessions: Session[]; prs: readonly TaskPr[]; branch: string; scope: DeleteActivityScope; force?: { promptsDir: string } }, deps: DeleteActivityDeps,
): Promise<void> {
  const { workspace, activity, task, sessions, prs, branch, scope, force } = job;
  const { log } = deps;
  const machine = deps.machineFor(activity);
  const repo = workspace.path;
  if (!activity.local) {
    const extras = await leftBehind(machine, repo, activity, branch); // a Restart's old branches (#283)
    if (!force) for (const name of extras) await refuseUnmerged(machine, repo, name); // all or nothing, as cleanWorktree checks its own
    const target = { id: teardownRunId(task.item.itemId), label: `#${task.item.id}`, workspace, force: force !== undefined };
    await removeInRun(machine, deps, target, (before) => (force
      ? removeWorktree(machine, repo, activity, branch, force.promptsDir, workspace.nestedRepos)
      : cleanWorktree(machine, repo, activity, branch, before, { nested: workspace.nestedRepos, prs, log }))); // #653, #660
    await dropBranches(machine, repo, extras, force !== undefined);
    await dropStageStart(machine, repo, activity.slug ?? slugFor(task.item)); // #812: a stage entry clears stageStart, never the ref; a missing ref is nothing
    await dropCheckpoints(machine, repo, activity.slug ?? slugFor(task.item)); // #619: every checkpoint's restore point goes with the activity; none is nothing
  }
  if (!scope.transcripts) return;
  await removeTranscripts(taskDir(repo, activity), repo, sessions, log) // a repo session in the main repo's dir too (#208)
    .catch((err: Error) => log.error(`transcripts #${task.item.id}: ${err.message}`));
}

// The ⋯ menu's delete activity (#182, #210, #573), also posted by the Settings worktree row and `clean up all orphans` (#181). The task is
// marked deleting before git, so no fill, manual start or delete-activity stage touches it while git runs; the answer drops the mark. Without
// force it is the delete-activity stage's git (no --force, branch -d), all or nothing: a refusal removes nothing and is an expected answer, 200
// with its code (#660), which the UI words and turns into the force popup. With a literal force: true it is the destructive removal; a failure
// there is a 500 `unexpected`. Either failure leaves the task's fields: nothing was confirmed gone. A success forgets what the scope removed (#236); nothing to
// delete (a delete-activity stage only) runs no git and just moves the task on. In a delete-activity stage a success advances the task as the
// stage's own deletion would (the reducer's activityRemoved, so every caller gets it). The mark lands synchronously inside dispatch, right after
// the check, so the check and the mark cannot be split by another request.
export function registerDeleteActivityRoute(app: Express, deps: TaskRouteDeps): void {
  const { requireLive, dispatch, log } = deps;
  app.post('/activities/:id/delete', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const target = taskTarget(current.state, activityParam(req)); // a live task activity (#629)
    if ('status' in target) return refuse(res, target);
    const { activity: live } = target;
    const task = removalRefusal(current.state, target.task.item.itemId);
    if ('status' in task) return refuse(res, task);
    const stranded = isStranded(current.runtime.config, live); // #746: its workspace left the Comb; a local one is just forgotten
    if (live.local && !stranded) return refuse(res, { status: HTTP_CONFLICT, message: LOCAL_MESSAGE }); // #444: no worktree to remove
    const scope = current.state.deleteActivity;
    // nothing to delete gets past removalRefusal only in a delete activity stage (#236): no git, no transcript, no workspace; the task just moves on
    const nothing = nothingToDelete(current.state, task, scope);
    const own = nothing || stranded ? undefined : workspaceOf(current.runtime.config, task, current.state.tasks); // the worktree's repo (#179)
    if (own && 'status' in own) return refuse(res, own);
    const force = (req.body as { force?: unknown } | undefined)?.force === true; // only a literal true forces
    const { config, promptsDir } = current.runtime;
    await dispatch({ type: 'deletingActivity', activityId: live.id });
    try {
      const sessions = sessionsOf(current.state, task.item.itemId);
      const workspace = stranded && !nothing ? await strandedWorkspace(live, task, deps.machineFor(live).exec) : own;
      if (workspace) await deleteActivityOnDisk({ workspace, activity: live, task, sessions, prs: recordOf(current.state, live.id)?.prs ?? [], branch: branchFor(config, task.item), scope, ...(force ? { force: { promptsDir } } : {}) }, deps);
      else if (stranded && !nothing) await strandedTranscripts(live, task, sessions, scope, log);
    } catch (err) {
      await dispatch({ type: 'activityKept', activityId: live.id });
      const label = `deleteActivity #${task.item.id}`;
      if (!force) return void res.json({ removed: false, refused: refusalOf(err, log, label) });
      log.error(`${label} forced: ${wordsOf(err)}`);
      res.status(HTTP_SERVER_ERROR).json({ error: UNEXPECTED }); // #660: the UI toasts its own copy; git's words are in hive.log
      return;
    }
    await dispatch({ type: 'activityRemoved', activityId: live.id });
    res.json({ removed: true });
  });
}
