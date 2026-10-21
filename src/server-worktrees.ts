import type { Express, Request, Response } from 'express';
import { canDiff } from './task-runs.js';
import { worktreeRows } from './tasks.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { diffBase } from './diff.js';
import { workspaceBase } from './fork.js';
import { type ConsoleStore, orphanTeardownRunId } from './console.js';
import type { Logger } from './log.js';
import { activityOf, keptActivity, worktreeOwner } from './activities.js';
import type { PtyHost } from './pty-host.js';
import { removeInRun } from './task-setup.js';
import type { Activity, Task, Config, Effect, Exec, HiveEvent, State, Workspace, WorktreeRow } from './types.js';
import { taskDir, cleanWorktree, listWorktrees, removeWorktree } from './worktree.js';
import type { FactLog } from './facts.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const NOT_LISTED_MESSAGE = 'worktree desconhecida'; // git lists no worktree with that slug under .hive/worktrees
const REMOVING_MESSAGE = 'worktree em remoção'; // a removal of this slug is still running git
const TASK_OWNED_MESSAGE = "use the task's remove"; // a task's worktree goes through /activities/:id/delete and its deleting mark (#182, #629)
const UNKNOWN_WORKSPACE_MESSAGE = 'unknown workspace';

export interface WorktreeRouteDeps {
  exec: Exec; // git; tests inject a fake and see the calls
  log: Pick<Logger, 'info'>;
  /** The workspace is read at call time: a POST /settings may have moved it (#202). baseBranch: what the activities' worktree line counts from (#586). */
  requireLive(res: Response): { state: State; runtime: { config: Pick<Config, 'comb' | 'baseBranch'>; promptsDir: string } } | undefined;
  ptys: Pick<PtyHost, 'adopt' | 'subscribe'>; // the teardown's console run (#654)
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  dispatch(event: HiveEvent): Promise<Effect[]>; // #861: a removed worktree's kept activity is marked gone, so pruneWork lets it go
  facts?: Pick<FactLog, 'write'>; // #742: the teardown's worktree.step
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The Settings tab's worktrees (#181). Read from git on demand and never kept in the state: the tab asks when it opens and after each
// action. A removal here touches no task, so nothing is dispatched; the log says what happened.
export function registerWorktreeRoutes(app: Express, deps: WorktreeRouteDeps): void {
  const { exec, requireLive } = deps;
  app.get('/worktrees', async (_req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    try {
      // every workspace, in config order (#179); a failure in any of them is the 500 with git's words
      const perWorkspace = await Promise.all(current.runtime.config.comb.workspaces.map(async ({ name, path }) => worktreeRows(await listWorktrees(path, exec), current.state, name)));
      res.json(perWorkspace.flat());
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) }); // git's own words: not a repo, a broken listing
    }
  });
  registerRemoveRoute(app, deps);
  registerBranchesRoute(app, deps);
  registerActivityWorktreesRoute(app, deps);
}

// What each workspace's checkout has out (redesign 08), for the terminal picker's rows: read from git on demand like the worktrees. A
// checkout git cannot read, or a detached one, answers null rather than failing the whole list.
function registerBranchesRoute(app: Express, { exec, requireLive }: WorktreeRouteDeps): void {
  app.get('/workspaces/branches', async (_req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const rows = await Promise.all(current.runtime.config.comb.workspaces.map(async ({ name, path }) => {
      const branch = await exec('git', ['-C', path, 'branch', '--show-current']).then(({ stdout }) => stdout.trim() || null, () => null);
      return { name, branch };
    }));
    res.json(rows);
  });
}

type WorktreeState = { itemId: string; changed: number; ahead: number };

const WORKTREE_READS = 4; // tasks read at once: each runs three git processes, and a Stop re-reads them all

// `run` over `items` with at most `limit` in flight, answers in the items' order
async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// One task's worktree state (#586). The path comes from the slug (taskDir), never from the activity's worktree path, which a hook posts; the base is the
// diff's own, so ↑N and the diff tab agree, and it goes after --end-of-options. core.fsmonitor=false: the worktree's config could name a
// monitor command that a status would run.
interface Work { task: Task; activity: Activity }

async function worktreeState({ task, activity }: Work, config: Pick<Config, 'comb' | 'baseBranch'>, exec: Exec): Promise<WorktreeState | undefined> {
  const workspace = taskWorkspace(config, task);
  if (!workspace) return undefined;
  const dir = taskDir(workspace.path, activity);
  const git = async (...args: string[]): Promise<string> => (await exec('git', ['-C', dir, ...args])).stdout;
  const base = await diffBase(task, activity, workspaceBase(config, workspace), dir, 'worktree', exec);
  const status = await git('-c', 'core.fsmonitor=false', 'status', '--porcelain');
  const ahead = await git('rev-list', '--count', '--end-of-options', `${base.commit}..HEAD`);
  return { itemId: task.item.itemId, changed: status.split('\n').filter((line) => line !== '').length, ahead: Number(ahead.trim()) };
}

// Each activity's worktree line (#586): files changed and commits ahead, for every task with a worktree on disk or on the checkout (#444).
// Read from git on demand like the branches, never kept; a task git cannot read answers no row rather than failing the whole list.
function registerActivityWorktreesRoute(app: Express, { exec, requireLive }: WorktreeRouteDeps): void {
  app.get('/activities/worktrees', async (_req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const { config } = current.runtime;
    const tasks = current.state.tasks.flatMap((task): Work[] => {
      const activity = activityOf(current.state, task.item.itemId);
      return activity && (activity.local || canDiff(task, activity, 'worktree')) ? [{ task, activity }] : [];
    });
    const rows = await mapLimited(tasks, WORKTREE_READS, (work) => worktreeState(work, config, exec).catch(() => undefined));
    res.json(rows.filter((row) => row !== undefined));
  });
}

// A worktree no task owns (#181). The slug reaches git's argv and a path, so only a slug git itself lists as a direct child of
// .hive/worktrees is accepted, and the branch passed on is the one git lists there (the fallback both functions take is never read: the
// path is listed). Without a literal force: true it is the delete activity stage's git, all or nothing, and a refusal is the expected 200 the UI
// turns into the force popup; with it, the forced removal, whose failure is a 500. There is no task to mark deleting. Either way a teardown
// run (#654) says what happened to the workspace's teardown.
function registerRemoveRoute(app: Express, deps: WorktreeRouteDeps): void {
  const removing = new Set<string>(); // <workspace>/<slug> whose git is running: a second click must not race the first
  app.post('/worktrees/:workspace/:slug/remove', async (req: Request, res: Response) => {
    if (!deps.requireLive(res)) return;
    const workspace = req.params.workspace as string;
    const slug = req.params.slug as string;
    const key = `${workspace}/${slug}`;
    if (removing.has(key)) {
      res.status(HTTP_CONFLICT).json({ error: REMOVING_MESSAGE });
      return;
    }
    removing.add(key);
    try {
      await removeOrphan(req, res, deps, workspace, slug);
    } finally {
      removing.delete(key);
    }
  });
}

// The removal itself (#181, #654) in a teardown run labelled by the slug: the teardown between git's checks and the remove, or the forced
// removal, which runs none. A failing step rejects as git's refusal does.
function removeListed(deps: WorktreeRouteDeps, workspace: Workspace, slug: string, branch: string, force?: { promptsDir: string }): Promise<void> {
  const target = { id: orphanTeardownRunId(workspace.name, slug), label: slug, workspace, force: force !== undefined };
  return removeInRun(deps, target, (before) => (force
    ? removeWorktree(workspace.path, { slug }, branch, force.promptsDir, deps.exec)
    : cleanWorktree(workspace.path, { slug }, branch, deps.exec, before)));
}

async function removeOrphan(req: Request, res: Response, deps: WorktreeRouteDeps, name: string, slug: string): Promise<void> {
  const { log, requireLive } = deps;
  const before = requireLive(res);
  if (!before) return;
  const workspace = workspaceByName(before.runtime.config, name); // a name from the URL is only looked up, never a path (#179)
  if (!workspace) {
    res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_WORKSPACE_MESSAGE });
    return;
  }
  const repo = workspace.path;
  const { promptsDir } = before.runtime;
  let listed: Pick<WorktreeRow, 'slug' | 'branch'> | undefined;
  try {
    listed = (await listWorktrees(repo, deps.exec)).find((w) => w.slug === slug);
  } catch (err) {
    res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
    return;
  }
  const current = requireLive(res); // read again after git: a task that took the slug meanwhile wins
  if (!current) return;
  if (!listed) {
    res.status(HTTP_NOT_FOUND).json({ error: NOT_LISTED_MESSAGE });
    return;
  }
  if (worktreeOwner(current.state, name, slug) !== undefined) {
    res.status(HTTP_CONFLICT).json({ error: TASK_OWNED_MESSAGE });
    return;
  }
  const force = (req.body as { force?: unknown } | undefined)?.force === true; // only a literal true forces
  const branch = listed.branch ?? ''; // detached: no branch to delete, and git's null wins over this fallback
  try {
    await removeListed(deps, workspace, slug, branch, force ? { promptsDir } : undefined);
  } catch (err) {
    log.info(`worktreeKept ${slug}`);
    if (force) res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
    else res.json({ removed: false, refused: errorMessage(err) });
    return;
  }
  log.info(`worktreeRemoved ${slug}`);
  const kept = keptActivity(current.state, name, slug); // #861: the activity kept for this worktree goes with it
  if (kept !== undefined) await deps.dispatch({ type: 'worktreeGone', activityId: kept.id });
  res.json({ removed: true });
}
