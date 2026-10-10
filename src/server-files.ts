import { realpath, stat } from 'node:fs/promises';
import type { Express, Request, Response } from 'express';
import { taskWorkspace, noWorkspaceReason, workspaceByName } from './config.js';
import { resolveActivityPath } from './ide.js';
import { resultOf } from './activities.js';
import { activityParam, keptTarget, UNKNOWN_ACTIVITY_MESSAGE, LOCAL_ACTIVITY_MESSAGE } from './activity-routes.js';
import type { TaskRouteDeps, Refusal } from './server-tasks.js';
import { resolveRef, TASK_REF } from './task-refs.js';
import type { Activity, Task, TaskFile, Config, State } from './types.js';
import { workDir } from './worktree.js';
import { originRepository } from './repos/repositories.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
export const UNKNOWN_WORKSPACE_MESSAGE = 'workspace desconhecido'; // a local activity whose workspace a save removed (#292); also the tree's (#633)
export const MISSING_FILE_MESSAGE = 'file not found';
const OPEN_REF_BODY_MESSAGE = 'ref must be #N or PREFIX-N'; // #588
const UNKNOWN_REF_MESSAGE = 'no task or issue for this reference'; // #588: a stale or foreign reference opens nothing

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

// What the file routes read from the disk (#258): realpath follows symlinks, so a link out of the task's folder is caught.
export const DISK = {
  realpath: (path: string): Promise<string> => realpath(path),
  isFile: (path: string): Promise<boolean> => stat(path).then((s) => s.isFile(), () => false),
};

interface TaskFolders { worktree?: string; workspace: string } // no worktree: a deleted activity's, so the main checkout

/** Where a task's files resolve (#258): its worktree, or its workspace root once that is gone; a task with no workspace has neither (409). */
function taskFolders(config: Pick<Config, 'comb'>, task: Task, activity: Activity | undefined): TaskFolders | Refusal {
  const workspace = taskWorkspace(config, task);
  return workspace ? { ...(activity ? { worktree: workDir(workspace.path, task, activity) } : {}), workspace: workspace.path } : { status: HTTP_CONFLICT, message: noWorkspaceReason(task) };
}

/** Every string of the task's result, at any key, that resolves to a file (#258, #697): relative to its worktree (its workspace once the
 *  worktree is gone), ../ or absolute, a separate docsRepo's included. What the details panel links. A URL, a number or a missing path is
 *  left out: none resolves to a file. */
async function taskFiles(result: Record<string, unknown>, folders: TaskFolders): Promise<TaskFile[]> {
  const paths = Object.entries(result).flatMap(([key, value]) => (typeof value === 'string' && value !== '' ? [{ key, path: value }] : []));
  const found = await Promise.all(paths.map(async (entry) => ({ ...entry, resolved: await resolveActivityPath({ ...folders, path: entry.path, ...DISK }) })));
  return found.flatMap(({ key, path, resolved }) => ('file' in resolved ? [{ key, path, base: resolved.base }] : []));
}

/** Where an activity's files resolve (#629): a task's folders, or a local activity's main checkout (#400), which has no worktree, so it is both.
 * The editor pane's routes resolve on the same folders (#717). */
export function activityFolders(config: Pick<Config, 'comb'>, target: { activity?: Activity; task?: Task }): TaskFolders | Refusal {
  if (target.task) return taskFolders(config, target.task, target.activity);
  if (!target.activity) return { status: HTTP_NOT_FOUND, message: UNKNOWN_ACTIVITY_MESSAGE };
  const workspace = workspaceByName(config, target.activity.workspace);
  return workspace ? { worktree: workspace.path, workspace: workspace.path } : { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE_MESSAGE };
}

// A task reference's click (#588): the body checked, then the task the Hive holds, or the issue in `repository`; nothing resolves, a 404
function openRef(res: Response, raw: unknown, state: State, repository?: string): void {
  const { ref } = (raw ?? {}) as { ref?: unknown };
  if (typeof ref !== 'string' || !TASK_REF.test(ref)) return void refuse(res, { status: HTTP_BAD_REQUEST, message: OPEN_REF_BODY_MESSAGE });
  const target = resolveRef(state, ref, repository);
  if (!target) return void refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_REF_MESSAGE });
  res.json(target);
}

// A terminal's task references (#588, #629), beside its file links: on a task's activity, the task's own repository, else the origin of the
// activity's workspace (a local activity's checkout). Read-only: nothing but git remote get-url runs, nothing is dispatched.
function registerRefRoutes(app: Express, { exec, requireLive }: Pick<TaskRouteDeps, 'exec' | 'requireLive'>): void {
  app.post('/activities/:id/open-ref', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const target = keptTarget(current.state, activityParam(req));
    if ('status' in target) return refuse(res, target);
    const { task, activity } = target;
    const { config } = current.runtime;
    const workspace = task ? taskWorkspace(config, task) : activity && workspaceByName(config, activity.workspace);
    if (!task && !workspace) return refuse(res, { status: HTTP_NOT_FOUND, message: activity ? UNKNOWN_WORKSPACE_MESSAGE : UNKNOWN_ACTIVITY_MESSAGE });
    const repository = task?.item.facets?.repository ?? (await originRepository(exec, workspace?.path));
    openRef(res, req.body, current.state, repository);
  });
}

// An activity's files (#258, #629): the list the details panel links (files), which open in the editor pane (#717), and a terminal's task
// references (open-ref). The IDE click (open-file) is gone with the IDE (#818).
export function registerFileRoutes(app: Express, deps: Pick<TaskRouteDeps, 'exec' | 'requireLive'>): void {
  const { requireLive } = deps;

  app.get('/activities/:id/files', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const target = keptTarget(current.state, activityParam(req));
    if ('status' in target) return refuse(res, target);
    const { task, activity } = target;
    if (!task) return refuse(res, activity ? { status: HTTP_CONFLICT, message: LOCAL_ACTIVITY_MESSAGE } : { status: HTTP_NOT_FOUND, message: UNKNOWN_ACTIVITY_MESSAGE });
    const folders = taskFolders(current.runtime.config, task, activity);
    if ('status' in folders) return void res.json([]); // no workspace: no links. No IDE no longer matters: they open in the editor pane (#717)
    try {
      res.json(await taskFiles(resultOf(current.state, task.item.itemId) ?? {}, folders));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
    }
  });

  registerRefRoutes(app, deps); // POST /activities/:id/open-ref (#588, #629), behind the same middleware as files
}
