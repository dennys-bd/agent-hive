import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { canDiff } from './task-runs.js';
import { taskWorkspace, noWorkspaceReason, workspaceByName } from './config.js';
import type { TaskRouteDeps, Refusal } from './server-tasks.js';
import { liveTarget } from './activity-routes.js';
import { revealCommand } from './platform-commands.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from './server-files.js';
import { treeItem } from './tree-paths.js';
import type { TaskTree, Exec, GitMark, State } from './types.js';
import { taskDir, wordsOf } from './worktree.js';

// The files sidebar (redesign 07): the worktree's paths with their git marks, and the ⋯'s show in folder.

const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
export const REVEAL_BODY_MESSAGE = 'path must be a non-empty string';
const HTTP_SERVER_ERROR = 500;
const HTTP_NO_CONTENT = 204;
const NO_WORKTREE_MESSAGE = 'tarefa sem worktree no disco';
const TREE_MAX_BYTES = 16 * 1024 * 1024; // a monorepo's path list passes execFile's 1 MB default long before it bothers the page
const RENAME_OR_COPY = /^[RC]/;
const MIN_ENTRY = 4; // `XY p`: two status letters, a space, at least one character of path

const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

const markOf = (xy: string): GitMark => (xy === '??' || RENAME_OR_COPY.test(xy) || xy.startsWith('A') ? 'A' : 'M');

/** `git status --porcelain=v1 -z` as marks and removed paths (redesign 07). A rename or copy carries its old path as the next entry, which is
 *  skipped: the new path reads as new. Pure: no git. */
export function parseStatus(text: string): { marks: Record<string, GitMark>; deleted: Set<string> } {
  const entries = text.split('\0');
  const marks: Record<string, GitMark> = {};
  const deleted = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < MIN_ENTRY) continue; // the trailing empty entry
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (RENAME_OR_COPY.test(xy)) i++;
    if (xy.includes('D')) deleted.add(path);
    else marks[path] = markOf(xy);
  }
  return { marks, deleted };
}

// --no-optional-locks: a status refreshes the index, and its lock would race the worker's own git; core.fsmonitor=false as in diff.ts.
const git = (worktree: string, args: string[], exec: Exec): Promise<string> =>
  exec('git', ['--no-optional-locks', '-C', worktree, '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args], { maxBuffer: TREE_MAX_BYTES })
    .then(({ stdout }) => stdout, (err: unknown) => { throw new Error(wordsOf(err)); });

const holdsGit = (folder: string): Promise<boolean> => access(join(folder, '.git')).then(() => true, () => false);

// The --directory listing's folders no listed file sits under (#818), relative, without their trailing /. A nested repository (it holds
// .git) is left out, as the files are. ponytail: git lists a folder that holds only empty folders as its outermost one, and a folder of
// ignored files as a folder: the tree shows either as empty; a per-folder walk if that ever misleads
async function emptyFolders(root: string, listing: string, files: readonly string[], hasGit: (folder: string) => Promise<boolean>): Promise<string[]> {
  const candidates = listing.split('\0').filter((entry) => entry.endsWith('/') && !files.some((file) => file.startsWith(entry)));
  const nested = await Promise.all(candidates.map((entry) => hasGit(join(root, entry))));
  return candidates.filter((_, i) => !nested[i]).map((entry) => entry.slice(0, -1));
}

/** Every path of the worktree git does not ignore (tracked, and untracked not excluded), minus the deleted ones, with their marks; its empty
 *  folders (#818); and its root, absolute. */
export async function taskTree(worktree: string, exec: Exec, hasGit: (folder: string) => Promise<boolean> = holdsGit): Promise<TaskTree> {
  const [listed, status, directories] = await Promise.all([
    git(worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], exec),
    git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], exec),
    git(worktree, ['ls-files', '-z', '--others', '--directory', '--exclude-standard'], exec),
  ]);
  const { marks, deleted } = parseStatus(status);
  // An unmerged path lists once per stage; an untracked nested repo lists as `dir/`, a folder git will not look into, so it is left out
  const files = [...new Set(listed.split('\0'))].filter((path) => path !== '' && !path.endsWith('/') && !deleted.has(path));
  return { root: worktree, files, marks, folders: await emptyFolders(worktree, directories, files, hasGit) };
}

// The tree's root, also POST /activities/:id/tree/move's (#594). A task's folder on disk: its worktree, or its workspace's checkout for a
// local run (#444), from the slug, never the activity's worktree path, which a hook posts. A local activity's root is its workspace's checkout
// (#633), from the workspace frozen on the activity, never a request value (#400).
export function treeRoot(state: State, config: Parameters<typeof taskWorkspace>[0], id: string): string | Refusal {
  const target = liveTarget(state, id);
  if ('status' in target) return target;
  const { task, activity } = target;
  if (!task) return workspaceByName(config, activity.workspace)?.path ?? { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE_MESSAGE };
  const workspace = taskWorkspace(config, task);
  if (!workspace) return { status: HTTP_CONFLICT, message: noWorkspaceReason(task) };
  if (!canDiff(task, activity, 'worktree')) return { status: HTTP_CONFLICT, message: NO_WORKTREE_MESSAGE };
  return taskDir(workspace.path, activity);
}

// POST /activities/:id/reveal (#658): the tree's root in the file manager, or with { path } that item of the tree (#818), checked as the
// tree's other routes check theirs
function registerRevealRoute(app: Express, { exec, requireLive }: Pick<TaskRouteDeps, 'exec' | 'requireLive'>): void {
  app.post('/activities/:id/reveal', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string);
    if (typeof root !== 'string') return refuse(res, root);
    const { path } = (req.body ?? {}) as { path?: unknown };
    if (path !== undefined && (typeof path !== 'string' || path === '')) return refuse(res, { status: HTTP_BAD_REQUEST, message: REVEAL_BODY_MESSAGE });
    try {
      const item = path === undefined ? root : await treeItem(root, path);
      if (typeof item !== 'string') return refuse(res, item);
      const isFile = path !== undefined && !(await lstat(item)).isDirectory(); // xdg-open would launch a file: Linux opens its folder
      const [file, args] = revealCommand(process.platform, item, isFile); // an unsupported platform throws here and answers 500 with its reason (#658)
      await exec(file, [...args]);
      res.status(HTTP_NO_CONTENT).end();
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) });
    }
  });
}

/** GET /activities/:id/tree, what the files sidebar polls, and POST /activities/:id/reveal. No value of the request picks the folder: it comes
 *  from the task's slug and workspace, or the local activity's workspace (#633). */
export function registerTreeRoutes(app: Express, deps: Pick<TaskRouteDeps, 'exec' | 'requireLive'>): void {
  app.get('/activities/:id/tree', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string);
    if (typeof root !== 'string') return refuse(res, root);
    try {
      res.json(await taskTree(root, deps.exec));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  registerRevealRoute(app, deps);
}
