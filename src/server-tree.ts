import { access, lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Express, Request, Response } from 'express';
import { canDiff } from './task-runs.js';
import { taskWorkspace, noWorkspaceReason, workspaceByName } from './config.js';
import type { TaskRouteDeps, Refusal } from './server-tasks.js';
import { liveTarget } from './activity-routes.js';
import { revealCommand } from './platform-commands.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from './server-files.js';
import { treeFolder, treeItem } from './tree-paths.js';
import type { FolderEntries, IgnoredEntries, TaskTree, Exec, GitMark, State } from './types.js';
import { taskDir, wordsOf } from './worktree.js';

// The files sidebar (redesign 07): the worktree's paths with their git marks, and the ⋯'s show in folder.

const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
export const REVEAL_BODY_MESSAGE = 'path must be a non-empty string';
export const FOLDER_QUERY_MESSAGE = 'path must be a string';
const HTTP_SERVER_ERROR = 500;
const HTTP_NO_CONTENT = 204;
const NO_WORKTREE_MESSAGE = 'tarefa sem worktree no disco';
const TREE_MAX_BYTES = 16 * 1024 * 1024; // a monorepo's path list passes execFile's 1 MB default long before it bothers the page
const RENAME_OR_COPY = /^[RC]/;
const MIN_ENTRY = 4; // `XY p`: two status letters, a space, at least one character of path
const IGNORED_XY = '!!'; // #1: what a status run with --ignored says of an ignored path
// #1: a nested repository's marks and what it ignores in one run; `matching` names an ignored folder `dir/` instead of every file under it
// --literal-pathspecs: a folder named `:(top)` or `*` is a name, not pathspec magic
const NESTED_STATUS_ARGS = ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'];
// HIVE-22: what git ignores, outermost: `dir/` for a folder it never walked into, a path for a file
const IGNORED_ARGS = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'];

const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

// D first (#903): an entry deleted in the index or the worktree is gone from the disk, whatever its other letter says
const markOf = (xy: string): GitMark => {
  if (xy.includes('D')) return 'D';
  return xy === '??' || RENAME_OR_COPY.test(xy) || xy.startsWith('A') ? 'A' : 'M';
};

/** `git status --porcelain=v1 -z` as marks and removed paths (redesign 07). A removed path is marked D as well (#903): the tree leaves it out
 *  of its files, and its folders take the mark. A rename or copy carries its old path as the next entry, which is
 *  skipped: the new path reads as new; with --ignored, the `!!` entries as ignored paths (#1). Pure: no git. */
export function parseStatus(text: string): { marks: Record<string, GitMark>; deleted: Set<string>; ignored: string[] } {
  const entries = text.split('\0');
  const marks: Record<string, GitMark> = {};
  const deleted = new Set<string>();
  const ignored: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < MIN_ENTRY) continue; // the trailing empty entry
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (RENAME_OR_COPY.test(xy)) i++;
    if (xy === IGNORED_XY) ignored.push(path);
    else {
      marks[path] = markOf(xy);
      // a staged delete re-created on disk comes back as `??` after its `D `: the later entry wins, so the file is listed again
      if (marks[path] === 'D') deleted.add(path);
      else deleted.delete(path);
    }
  }
  return { marks, deleted, ignored };
}

/** A nested repository's view of a folder's children (#1), from its `git status` limited to that folder (paths relative to the repository):
 *  the direct child files' marks, as parseStatus reads them, and the children it ignores, an ignored folder (`dir/`) covering its subtree.
 *  `inRepo` is the folder relative to the repository, '' at its root. Only names on disk; sorted. Pure: no git. */
export function repoViewOf(status: string, inRepo: string, children: FolderEntries): NonNullable<FolderEntries['repo']> {
  const prefix = inRepo === '' ? '' : `${inRepo}/`;
  const { marks, deleted, ignored } = parseStatus(status);
  const isIgnored = (name: string): boolean => {
    const path = `${prefix}${name}`;
    return ignored.some((entry) => entry === path || entry === `${path}/` || (entry.endsWith('/') && path.startsWith(entry)));
  };
  // hasOwn: a file named `constructor` must not pick up Object's
  const childMarks = children.files.flatMap((name) => (Object.hasOwn(marks, `${prefix}${name}`) ? [[name, marks[`${prefix}${name}`]] as const] : []));
  // #903: a deleted direct child is not on disk, so no row; its mark is there for the folders above it
  const goneMarks = [...deleted].filter((path) => path.startsWith(prefix) && !path.includes('/', prefix.length)).map((path) => [path.slice(prefix.length), 'D'] as const);
  return { marks: Object.fromEntries([...childMarks, ...goneMarks]), ignored: [...children.folders, ...children.files].filter(isIgnored).sort() };
}

// --no-optional-locks: a status refreshes the index, and its lock would race the worker's own git; core.fsmonitor=false as in diff.ts.
const git = (worktree: string, args: string[], exec: Exec): Promise<string> =>
  exec('git', ['--no-optional-locks', '-C', worktree, '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args], { maxBuffer: TREE_MAX_BYTES })
    .then(({ stdout }) => stdout, (err: unknown) => { throw new Error(wordsOf(err)); });

const holdsGit = (folder: string): Promise<boolean> => access(join(folder, '.git')).then(() => true, () => false);

/** The nested repository a folder of the tree lies in (#1): the nearest folder holding .git (a directory, or a worktree's file) from `folder`
 *  up, so a repository inside a nested one answers for its own files. The tree's root is left out: its own git already marks the tree.
 *  Relative to `root`, as `folder` is ('' is the root); undefined outside any. */
export async function nestedRepoOf(root: string, folder: string, hasGit: (folder: string) => Promise<boolean>): Promise<string | undefined> {
  const candidates = folder === '' ? [] : folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')).reverse();
  const holds = await Promise.all(candidates.map((candidate) => hasGit(join(root, candidate))));
  return candidates.find((_, i) => holds[i]);
}

// The --directory listing's folders no listed file sits under (#818), relative, without their trailing /: the empty ones, and the nested
// repositories (they hold .git), which the tree shows as ignored folders (HIVE-22). ponytail: git lists a folder that holds only empty
// folders as its outermost one, and a folder of ignored files as a folder: the tree shows either as empty; a per-folder walk if that ever misleads
async function emptyFolders(root: string, listing: string, files: readonly string[], hasGit: (folder: string) => Promise<boolean>): Promise<{ empty: string[]; nested: string[] }> {
  const candidates = listing.split('\0').filter((entry) => entry.endsWith('/') && !files.some((file) => file.startsWith(entry)));
  const isNested = await Promise.all(candidates.map((entry) => hasGit(join(root, entry))));
  const folders = candidates.map((entry) => entry.slice(0, -1));
  return { empty: folders.filter((_, i) => !isNested[i]), nested: folders.filter((_, i) => isNested[i]) };
}

// git never lists .git; the filter is a guard, case-insensitive as tree-paths.ts's (APFS resolves `.GIT` to `.git`)
const isGitEntry = (entry: string): boolean => entry.split('/').some((part) => part.toLowerCase() === '.git');

// Sorted: the answer must not depend on git's or Promise.all's order (CI runs on Linux)
function ignoredOf(listing: string, nested: readonly string[]): IgnoredEntries {
  const entries = listing.split('\0').filter((entry) => entry !== '' && !isGitEntry(entry));
  const folders = entries.filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1));
  return { files: entries.filter((entry) => !entry.endsWith('/')).sort(), folders: [...folders, ...nested].sort() };
}

/** Every path of the worktree git does not ignore (tracked, and untracked not excluded), minus the deleted ones, with their marks (a deleted path's `D` in the marks only, #903); its empty
 *  folders (#818); what git ignores and its nested repositories (HIVE-22); its root, absolute; and the branch it has out (#713). */
export async function taskTree(worktree: string, exec: Exec, hasGit: (folder: string) => Promise<boolean> = holdsGit): Promise<TaskTree> {
  const [listed, status, directories, ignored, branch] = await Promise.all([
    git(worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], exec),
    git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], exec),
    git(worktree, ['ls-files', '-z', '--others', '--directory', '--exclude-standard'], exec),
    git(worktree, IGNORED_ARGS, exec),
    // #713: read with every poll, so a checkout switch shows; a detached HEAD or a failed read is no branch, never a failed tree
    git(worktree, ['branch', '--show-current'], exec).then((out) => out.trim(), () => ''),
  ]);
  const { marks, deleted } = parseStatus(status);
  // An unmerged path lists once per stage; an untracked nested repo lists as `dir/`, a folder git will not look into, so it is left out here
  const files = [...new Set(listed.split('\0'))].filter((path) => path !== '' && !path.endsWith('/') && !deleted.has(path));
  const { empty, nested } = await emptyFolders(worktree, directories, files, hasGit);
  return { root: worktree, ...(branch === '' ? {} : { branch }), files, marks, folders: empty, ignored: ignoredOf(ignored, nested) };
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

// #131: the tree's root as a session or a terminal at the main checkout reaches it (`.hive/worktrees/<slug>`), resolved as treeRoot resolves
// a task's. Undefined when the root is the checkout itself: a local activity (#633) or a task's local run (#444), whose copy would be the
// relative path again
export function treeCheckout(state: State, config: Parameters<typeof taskWorkspace>[0], id: string, root: string): string | undefined {
  const target = liveTarget(state, id);
  if ('status' in target || !target.task) return undefined;
  const workspace = taskWorkspace(config, target.task);
  // The page joins it with '/', so a Windows separator would mix
  const checkout = workspace === undefined ? '' : relative(workspace.path, root).split(sep).join('/');
  return checkout === '' ? undefined : checkout;
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

// A directory is a folder; anything else, a symlink too, is a file: the tree opens it and never walks through it. ponytail: no cap on the
// listing, and an expanded folder is re-read every poll; a truncated answer if a huge expanded folder (node_modules) ever slows the tree
async function diskEntries(folder: string): Promise<FolderEntries> {
  const entries = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.name.toLowerCase() !== '.git');
  const namesOf = (isFolder: boolean): string[] => entries.filter((entry) => entry.isDirectory() === isFolder).map((entry) => entry.name).sort();
  return { files: namesOf(false), folders: namesOf(true) };
}

// HIVE-22's listing, and inside a nested repository (#1) that repository's view of it. The walk up runs on the query's path as written,
// normalized: `folder` is real, and on macOS a real path need not start with the root as written. ponytail: one pathspec-limited git status
// per expanded folder inside a nested repository per poll (POLL_MS); one status per nested repository, shared by its expanded folders, if a
// big one ever slows the tree
async function folderEntries(root: string, path: string, folder: string, exec: Exec): Promise<FolderEntries> {
  const children = await diskEntries(folder);
  const inTree = relative(root, resolve(root, path)); // '' is the root
  const repo = await nestedRepoOf(root, inTree, holdsGit);
  if (repo === undefined) return children;
  const inRepo = inTree === repo ? '' : inTree.slice(repo.length + 1);
  // A broken nested repository (a gitdir gone, dubious ownership) must not empty the folder: it reads as HIVE-22 showed it, dimmed
  const status = await git(join(root, repo), [...NESTED_STATUS_ARGS, '--', inRepo === '' ? '.' : inRepo], exec).catch(() => undefined);
  return status === undefined ? children : { ...children, repo: repoViewOf(status, inRepo, children) };
}

// GET /activities/:id/tree/folder (HIVE-22): a folder's children from disk, what an expanded ignored folder shows. Any folder of the tree is
// taken: the route reads names, and only a folder inside a nested repository costs a git run (#1)
function registerFolderRoute(app: Express, { exec, requireLive }: Pick<TaskRouteDeps, 'exec' | 'requireLive'>): void {
  app.get('/activities/:id/tree/folder', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string);
    if (typeof root !== 'string') return refuse(res, root);
    const { path } = req.query;
    if (typeof path !== 'string') return refuse(res, { status: HTTP_BAD_REQUEST, message: FOLDER_QUERY_MESSAGE });
    try {
      const folder = await treeFolder(root, path);
      if (typeof folder !== 'string') return refuse(res, folder);
      res.json(await folderEntries(root, path, folder, exec));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) });
    }
  });
}

/** GET /activities/:id/tree, what the files sidebar polls, POST /activities/:id/reveal and GET /activities/:id/tree/folder (HIVE-22). No value of the request picks the folder: it comes
 *  from the task's slug and workspace, or the local activity's workspace (#633). */
export function registerTreeRoutes(app: Express, deps: Pick<TaskRouteDeps, 'exec' | 'requireLive'>): void {
  app.get('/activities/:id/tree', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string);
    if (typeof root !== 'string') return refuse(res, root);
    try {
      const tree = await taskTree(root, deps.exec);
      const checkout = treeCheckout(current.state, current.runtime.config, req.params.id as string, root);
      res.json(checkout === undefined ? tree : { ...tree, checkout });
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  registerRevealRoute(app, deps);
  registerFolderRoute(app, deps);
}
