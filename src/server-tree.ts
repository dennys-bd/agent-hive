import type { Express, Request, Response } from 'express';
import { type Machine, type MachineFor, pathsOf } from './machine.js';
import { canDiff } from './task-runs.js';
import { taskWorkspace, noWorkspaceReason, noWorkspaceFields, workspaceByName } from './config.js';
import type { TaskRouteDeps, Refusal } from './server-tasks.js';
import { liveTarget } from './activity-routes.js';
import { revealCommand } from './platform-commands.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from './server-files.js';
import { isLocal, pathFs, REMOTE_REFUSAL } from './machine-fs.js';
import { treeFolder, treeItem } from './tree-paths.js';
import type { FolderEntries, IgnoredEntries, TaskTree, GitMark, State } from './types.js';
import { toWire } from './wire-path.js';
import { taskDir, wordsOf } from './worktree.js';
import { gitIn, parseStatus, TREE_STATUS_ARGS } from './git-status.js';

// The files sidebar (redesign 07): the worktree's paths with their git marks, and the ⋯'s show in folder.

const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
export const REVEAL_BODY_MESSAGE = 'path must be a non-empty string';
export const FOLDER_QUERY_MESSAGE = 'path must be a string';
const HTTP_SERVER_ERROR = 500;
const HTTP_NO_CONTENT = 204;
const NO_WORKTREE_MESSAGE = 'tarefa sem worktree no disco';
// #1: a nested repository's marks and what it ignores in one run (porcelain v2, #502); `matching` names an ignored folder `dir/` instead of every file under it
// --literal-pathspecs: a folder named `:(top)` or `*` is a name, not pathspec magic
const NESTED_STATUS_ARGS = ['--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching'];

// #748: a gone workspace's code and name ride along, for the page to word; undefined drops out of the JSON
const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message, code: refusal.code, workspace: refusal.workspace });
};

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

const holdsGit = (machine: Machine, folder: string): Promise<boolean> => machine.fs.access(machine.paths.join(folder, '.git')).then(() => true, () => false);

/** The nested repository a folder of the tree lies in (#1): the nearest folder holding .git (a directory, or a worktree's file) from `folder`
 *  up, so a repository inside a nested one answers for its own files. The tree's root is left out: its own git already marks the tree.
 *  Relative to `root`, as `folder` is ('' is the root); undefined outside any. */
export async function nestedRepoOf(root: string, folder: string, hasGit: (folder: string) => Promise<boolean>, paths: Machine['paths']): Promise<string | undefined> {
  const candidates = folder === '' ? [] : folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')).reverse();
  const holds = await Promise.all(candidates.map((candidate) => hasGit(paths.join(root, candidate))));
  return candidates.find((_, i) => holds[i]);
}

// The --directory listing's folders no listed file sits under (#818), relative, without their trailing /: the empty ones, and the nested
// repositories (they hold .git), which the tree shows as ignored folders (HIVE-22). ponytail: git lists a folder that holds only empty
// folders as its outermost one, and a folder of ignored files as a folder: the tree shows either as empty; a per-folder walk if that ever misleads
async function emptyFolders(root: string, listing: string, files: readonly string[], hasGit: (folder: string) => Promise<boolean>, paths: Machine['paths']): Promise<{ empty: string[]; nested: string[] }> {
  const candidates = listing.split('\0').filter((entry) => entry.endsWith('/') && !files.some((file) => file.startsWith(entry)));
  const isNested = await Promise.all(candidates.map((entry) => hasGit(paths.join(root, entry))));
  const folders = candidates.map((entry) => entry.slice(0, -1));
  return { empty: folders.filter((_, i) => !isNested[i]), nested: folders.filter((_, i) => isNested[i]) };
}

// git never lists .git; the filter is a guard, case-insensitive as tree-paths.ts's (APFS resolves `.GIT` to `.git`)
const isGitEntry = (entry: string): boolean => entry.split('/').some((part) => part.toLowerCase() === '.git');

/** The nested repositories under the tree's root (#868): every folder git lists as untracked, an ignored one included (the docs/ this
 *  repository ignores), that holds .git, as emptyFolders tells one (HIVE-22). Relative, sorted. ponytail: one level, git collapses an untracked
 *  folder to its outermost one, so a repository inside an untracked plain folder or inside a nested one is not found; walk each if one must be */
export async function nestedRepos(machine: Machine, root: string): Promise<string[]> {
  const listing = await gitIn(root, ['ls-files', '-z', '--others', '--directory'], machine.exec);
  const folders = listing.split('\0').filter((entry) => entry.endsWith('/') && !isGitEntry(entry));
  const holds = await Promise.all(folders.map((folder) => holdsGit(machine, machine.paths.join(root, folder))));
  return folders.filter((_, i) => holds[i]).map((folder) => folder.slice(0, -1)).sort();
}

// --untracked-files=normal names an untracked folder once (`dir/`, #502): every listed entry under it is new, as -uall's per-file `??` marked
// it, a nested repository's `dir/` entry included
export function untrackedMarks(entries: readonly string[], untracked: readonly string[]): Record<string, GitMark> {
  const folders = new Set(untracked);
  // Each `/` of an entry ends one ancestor folder (the entry itself for a `dir/`): a set lookup per level, not a scan of every folder
  const isUntracked = (entry: string): boolean => {
    for (let at = entry.indexOf('/'); at !== -1; at = entry.indexOf('/', at + 1)) if (folders.has(entry.slice(0, at + 1))) return true;
    return false;
  };
  return Object.fromEntries(entries.filter(isUntracked).map((entry) => [entry, 'A'] as const));
}

// Sorted: the answer must not depend on git's or Promise.all's order (CI runs on Linux)
function ignoredOf(entries: readonly string[], nested: readonly string[]): IgnoredEntries {
  const kept = entries.filter((entry) => !isGitEntry(entry));
  const folders = kept.filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1));
  return { files: kept.filter((entry) => !entry.endsWith('/')).sort(), folders: [...folders, ...nested].sort() };
}

/** Every path of the worktree git does not ignore (tracked, and untracked not excluded), minus the deleted ones, with their marks (a deleted
 *  path's `D` in the marks only, #903); its empty folders (#818); what git ignores and its nested repositories (HIVE-22); its root, absolute;
 *  and the branch it has out (#713). Three git runs (#502): git status never lists a clean tracked file, nor an empty folder. */
export async function taskTree(machine: Machine, worktree: string): Promise<TaskTree> {
  const { exec } = machine;
  const [listed, status, directories] = await Promise.all([
    gitIn(worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], exec),
    gitIn(worktree, TREE_STATUS_ARGS, exec),
    gitIn(worktree, ['ls-files', '-z', '--others', '--directory', '--exclude-standard'], exec),
  ]);
  const { marks, deleted, ignored, untracked, branch } = parseStatus(status);
  // An unmerged path lists once per stage; an untracked nested repo lists as `dir/`, a folder git will not look into, so it is no file
  const entries = [...new Set(listed.split('\0'))].filter((path) => path !== '');
  const files = entries.filter((path) => !path.endsWith('/') && !deleted.has(path));
  const { empty, nested } = await emptyFolders(worktree, directories, files, (folder) => holdsGit(machine, folder), machine.paths);
  return { root: worktree, ...(branch === undefined ? {} : { branch }), files, marks: { ...marks, ...untrackedMarks(entries, untracked) }, folders: empty, ignored: ignoredOf(ignored, nested) };
}

// The tree's root, also POST /activities/:id/tree/move's (#594). A task's folder on disk: its worktree, or its workspace's checkout for a
// local run (#444), from the slug, never the activity's worktree path, which a hook posts. A local activity's root is its workspace's checkout
// (#633), from the workspace frozen on the activity, never a request value (#400).
export function treeRoot(state: State, config: Parameters<typeof taskWorkspace>[0], id: string, machineFor: MachineFor): string | Refusal {
  const target = liveTarget(state, id);
  if ('status' in target) return target;
  const { task, activity } = target;
  if (!task) return workspaceByName(config, activity.workspace)?.path ?? { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE_MESSAGE };
  const workspace = taskWorkspace(config, task);
  if (!workspace) return { status: HTTP_CONFLICT, message: noWorkspaceReason(task), ...noWorkspaceFields(task) };
  if (!canDiff(task, activity, 'worktree')) return { status: HTTP_CONFLICT, message: NO_WORKTREE_MESSAGE };
  return taskDir(machineFor(activity).paths, workspace.path, activity);
}

/** The machine a tree route's root is on (#160): the live activity's. treeRoot has refused anything else already. */
export function treeMachine(state: State, id: string, machineFor: MachineFor): Machine {
  const target = liveTarget(state, id);
  return machineFor('status' in target ? {} : target.activity);
}

// #131: the tree's root as a session or a terminal at the main checkout reaches it (`.hive/worktrees/<slug>`), resolved as treeRoot resolves
// a task's. Undefined when the root is the checkout itself: a local activity (#633) or a task's local run (#444), whose copy would be the
// relative path again
export function treeCheckout(state: State, config: Parameters<typeof taskWorkspace>[0], id: string, root: string, machine: Pick<Machine, 'paths' | 'info'>): string | undefined {
  const target = liveTarget(state, id);
  if ('status' in target || !target.task) return undefined;
  const workspace = taskWorkspace(config, target.task);
  // The page joins it with '/' (#641: toWire)
  const checkout = workspace === undefined ? '' : toWire(machine.paths.relative(workspace.path, root), machine.info().platform);
  return checkout === '' ? undefined : checkout;
}

// POST /activities/:id/reveal (#658): the tree's root in the file manager, or with { path } that item of the tree (#818), checked as the
// tree's other routes check theirs
function registerRevealRoute(app: Express, { exec, requireLive, machineFor }: Pick<TaskRouteDeps, 'exec' | 'requireLive' | 'machineFor'>): void {
  app.post('/activities/:id/reveal', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const id = req.params.id as string;
    const root = treeRoot(current.state, current.runtime.config, id, machineFor);
    if (typeof root !== 'string') return refuse(res, root);
    const machine = treeMachine(current.state, id, machineFor);
    if (!isLocal(machine)) return refuse(res, REMOTE_REFUSAL); // the file manager is this computer's; another machine's folder is not on it
    const { path } = (req.body ?? {}) as { path?: unknown };
    if (path !== undefined && (typeof path !== 'string' || path === '')) return refuse(res, { status: HTTP_BAD_REQUEST, message: REVEAL_BODY_MESSAGE });
    try {
      const item = path === undefined ? root : await treeItem(root, path, pathFs(machine));
      if (typeof item !== 'string') return refuse(res, item);
      const isFile = path !== undefined && !(await machine.fs.lstat(item)).isDirectory(); // xdg-open would launch a file: Linux opens its folder
      const [file, args] = revealCommand(process.platform, item, isFile); // an unsupported platform throws here and answers 500 with its reason (#658)
      await exec(file, [...args]);
      res.status(HTTP_NO_CONTENT).end();
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) });
    }
  });
}

// A directory is a folder; anything else, a symlink too, is a file: the tree opens it and never walks through it. ponytail: no cap on the
// listing, and an expanded folder is re-read on each tree event under it (#502); a truncated answer if a huge expanded folder (node_modules) ever slows the tree
async function diskEntries(machine: Machine, folder: string): Promise<FolderEntries> {
  const entries = (await machine.fs.readdir(folder, { withFileTypes: true })).filter((entry) => entry.name.toLowerCase() !== '.git');
  const namesOf = (isFolder: boolean): string[] => entries.filter((entry) => entry.isDirectory() === isFolder).map((entry) => entry.name).sort();
  return { files: namesOf(false), folders: namesOf(true) };
}

// The folder the query names, relative to the tree's root, in the wire's spelling: nestedRepoOf splits on `/`, and win32's relative gives `docs\agent`.
// '' is the root. Real paths on macOS need not start with the root as written, so the query's path is resolved against it.
export function inTreeOf(root: string, path: string, platform: NodeJS.Platform): string {
  const flavour = pathsOf(platform);
  return toWire(flavour.relative(root, flavour.resolve(root, path)), platform);
}

// HIVE-22's listing, and inside a nested repository (#1) that repository's view of it. The walk up runs on the query's path as written,
// normalized: `folder` is real, and on macOS a real path need not start with the root as written. ponytail: one pathspec-limited git status
// per read of an expanded folder inside a nested repository (on its own index or HEAD change, focus or a tree operation, #502); one status per nested repository, shared by its expanded folders, if a
// big one ever slows the tree
async function folderEntries(machine: Machine, root: string, path: string, folder: string, onNested: (repo: string) => void): Promise<FolderEntries> {
  const children = await diskEntries(machine, folder);
  const inTree = inTreeOf(root, path, machine.info().platform);
  const repo = await nestedRepoOf(root, inTree, (f) => holdsGit(machine, f), machine.paths);
  if (repo === undefined) return children;
  onNested(repo);
  const inRepo = inTree === repo ? '' : inTree.slice(repo.length + 1);
  // A broken nested repository (a gitdir gone, dubious ownership) must not empty the folder: it reads as HIVE-22 showed it, dimmed
  const status = await gitIn(machine.paths.join(root, repo), [...NESTED_STATUS_ARGS, '--', inRepo === '' ? '.' : inRepo], machine.exec).catch(() => undefined);
  return status === undefined ? children : { ...children, repo: repoViewOf(status, inRepo, children) };
}

// GET /activities/:id/tree/folder (HIVE-22): a folder's children from disk, what an expanded ignored folder shows. Any folder of the tree is
// taken: the route reads names, and only a folder inside a nested repository costs a git run (#1)
function registerFolderRoute(app: Express, { requireLive, treeWatch, machineFor }: Pick<TaskRouteDeps, 'requireLive' | 'treeWatch' | 'machineFor'>): void {
  app.get('/activities/:id/tree/folder', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const id = req.params.id as string;
    const root = treeRoot(current.state, current.runtime.config, id, machineFor);
    if (typeof root !== 'string') return refuse(res, root);
    const machine = treeMachine(current.state, id, machineFor);
    const { path } = req.query;
    if (typeof path !== 'string') return refuse(res, { status: HTTP_BAD_REQUEST, message: FOLDER_QUERY_MESSAGE });
    try {
      const folder = await treeFolder(root, path, pathFs(machine));
      if (typeof folder !== 'string') return refuse(res, folder);
      // #502: an expanded nested repository's stage, commit and switch push; the watch ignores an unleased root
      res.json(await folderEntries(machine, root, path, folder, (repo) => void treeWatch.watchNested(machine, root, repo)));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) });
    }
  });
}

/** GET /activities/:id/tree, what the files sidebar reads, POST /activities/:id/reveal and GET /activities/:id/tree/folder (HIVE-22). No value of the request picks the folder: it comes
 *  from the task's slug and workspace, or the local activity's workspace (#633). */
export function registerTreeRoutes(app: Express, deps: Pick<TaskRouteDeps, 'exec' | 'requireLive' | 'treeWatch' | 'machineFor'>): void {
  app.get('/activities/:id/tree', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string, deps.machineFor);
    if (typeof root !== 'string') return refuse(res, root);
    try {
      const machine = treeMachine(current.state, req.params.id as string, deps.machineFor);
      const tree = await taskTree(machine, root);
      const checkout = treeCheckout(current.state, current.runtime.config, req.params.id as string, root, machine);
      res.json(checkout === undefined ? tree : { ...tree, checkout });
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  registerRevealRoute(app, deps);
  registerFolderRoute(app, deps);
}
