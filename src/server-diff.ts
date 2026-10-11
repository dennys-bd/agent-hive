import type { Express, Request, Response } from 'express';
import { canDiff } from './task-runs.js';
import { taskWorkspace, noWorkspaceReason } from './config.js';
import { workspaceBase } from './fork.js';
import { taskDiff, commitDiff, diffBase, DiffTooLarge, isScope, NoParentCommit } from './diff.js';
import { dropStaleMarks } from './review-store.js';
import type { TaskRouteDeps, Refusal } from './server-tasks.js';
import { activityParam, taskTarget } from './activity-routes.js';
import type { Activity, Task, TaskDiff, DiffScope, FileDiff } from './types.js';
import { taskDir } from './worktree.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_SERVER_ERROR = 500;
const SCOPE_MESSAGE = 'scope deve ser stage, worktree, commit ou checkpoint';
const NO_CHECKPOINTS_MESSAGE = 'a tarefa não tem pontos de restauração';
const CHECKPOINT_MESSAGE = 'informe checkpoint: o número de um ponto de restauração da tarefa';
const NO_PARENT_MESSAGE = 'o último commit não tem pai';
const NO_WORKTREE_MESSAGE = 'tarefa sem worktree no disco';
const NO_STAGE_START_MESSAGE = 'a etapa atual não tem início registrado';
const TOO_LARGE_MESSAGE = 'diff grande demais para o visualizador';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

// Why the task has no diff of `scope` (#270): canDiff's two reasons, worded apart; undefined when it has one.
function noDiffReason(task: Task, activity: Activity | undefined, scope: DiffScope): string | undefined {
  if (canDiff(task, activity, scope)) return undefined;
  if (!canDiff(task, activity, 'worktree')) return NO_WORKTREE_MESSAGE;
  return scope === 'checkpoint' ? NO_CHECKPOINTS_MESSAGE : NO_STAGE_START_MESSAGE;
}

// A failed diff as its answer (#270, #591): a root commit's 409, an oversized diff's 413, git's own words as a 500
function failure(err: unknown): Refusal {
  if (err instanceof NoParentCommit) return { status: HTTP_CONFLICT, message: NO_PARENT_MESSAGE };
  if (err instanceof DiffTooLarge) return { status: HTTP_TOO_LARGE, message: TOO_LARGE_MESSAGE };
  return { status: HTTP_SERVER_ERROR, message: errorMessage(err) };
}

// A diff just read tells which reviewed marks of its scope went stale (#591): dropped after the answer, broadcast only when some went
async function dropStale(deps: Pick<TaskRouteDeps, 'reviews' | 'notifyReview' | 'log'>, itemId: string, scope: DiffScope, files: FileDiff[]): Promise<void> {
  try {
    const current = await deps.reviews.read(itemId);
    if (dropStaleMarks(current, scope, files) === current) return;
    await deps.reviews.update(itemId, (file) => dropStaleMarks(file, scope, files));
    deps.notifyReview(itemId);
  } catch (err) {
    // A fixed line: a JSON.parse error of the review file quotes its content, the review text among it
    deps.log.error(`review ${itemId}: the stale marks could not be dropped (${err instanceof Error ? err.name : 'error'})`);
  }
}

/** GET /activities/:id/diff?scope=stage|worktree|commit|checkpoint (with `&checkpoint=<n>` for the last; #270, #591): the task's worktree on disk against the scope's base, as files, hunks and lines. The path
 * comes from the slug (taskDir), never from the activity's worktree path, which a hook posts. No value of the request reaches git: `scope` only picks a
 * branch here, and the base is a sha or a ref the Hive stored. Read-only for the repo: see taskDiff. */
export function registerDiffRoutes(app: Express, deps: Pick<TaskRouteDeps, 'exec' | 'requireLive' | 'reviews' | 'notifyReview' | 'log'>): void {
  const { exec, requireLive } = deps;
  // The latest diff started per task and scope: only its files may drop marks, an older one finishing late would drop a mark made
  // against a newer diff. ponytail: one entry per task and scope, never pruned; a task's three keys are a few bytes
  const latest = new Map<string, number>();
  app.get('/activities/:id/diff', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const target = taskTarget(current.state, activityParam(req));
    if ('status' in target) return refuse(res, target);
    const { task, activity } = target;
    const { scope } = req.query;
    if (!isScope(scope)) return refuse(res, { status: HTTP_BAD_REQUEST, message: SCOPE_MESSAGE });
    const { config } = current.runtime;
    const workspace = taskWorkspace(config, task);
    if (!workspace) return refuse(res, { status: HTTP_CONFLICT, message: noWorkspaceReason(task) });
    const reason = noDiffReason(task, activity, scope);
    if (reason) return refuse(res, { status: HTTP_CONFLICT, message: reason });
    const checkpoint = scope === 'checkpoint' ? activity.checkpoints?.find((a) => String(a.n) === req.query.checkpoint) : undefined; // #619: only an n the activity lists reaches git, as a sha it stored
    if (scope === 'checkpoint' && checkpoint === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: CHECKPOINT_MESSAGE });
    const worktree = taskDir(workspace.path, activity); // the checkout for a local task (#444)
    const key = `${task.item.itemId}\n${scope}${checkpoint?.n ?? ''}`;
    const mine = (latest.get(key) ?? 0) + 1;
    latest.set(key, mine);
    try {
      const base = await diffBase(task, activity, workspaceBase(config, workspace), worktree, scope, exec, checkpoint);
      const files = scope === 'commit' ? await commitDiff(worktree, exec) : await taskDiff(worktree, base.commit, exec);
      const answer: TaskDiff = { scope, base: base.label, files };
      res.json(answer);
      // The checkpoint scope's marks are keyed by scope and path, shared by every checkpoint number: one checkpoint's files cannot tell which marks of
      // another are stale. isReviewedIn compares the hash, so a leftover mark reads unreviewed until its own diff matches.
      if (scope !== 'checkpoint' && latest.get(key) === mine) await dropStale(deps, task.item.itemId, scope, files);
    } catch (err) {
      refuse(res, failure(err));
    }
  });
}
