import type { Express, Request, Response } from 'express';
import { activityOf, recordOf, taskOfActivity, workersIn } from './activities.js';
import { workspaceByName } from './config.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from './server-memory.js';
import { workspaceRows, type WorktreeRouteDeps } from './server-worktrees.js';
import { removalBlocker, taskId, taskLabel } from './tasks.js';
import type { Activity, HeldActivity, HoldingBlocker, State, Task, TaskPr, UnmergedBranch, Workspace, WorkspaceHoldings, WorktreeRow } from './types.js';
import { mergedByPr, refuseUnmerged, wordsOf } from './worktree.js';
import { RemovalRefusal, UNEXPECTED } from './worktree-base.js';

// What a saved workspace still holds (#750), for the removal dialog of #751. The state's part is pure; the route (below) adds git's.

type HeldState = Pick<State, 'tasks' | 'workers' | 'stages' | 'deleteActivity' | 'activities' | 'activityRecords'>;

// Decision 5: a run or a deletion in flight is the stronger reason; a local activity has no worktree, so removalBlocker would call it
// nothingToDelete, and local says why truly
function holdingBlocker(task: Task, activity: Activity, state: HeldState): HoldingBlocker | undefined {
  const blocker = removalBlocker(task, state);
  if (blocker === 'running' || blocker === 'deleting') return blocker;
  return activity.local ? 'local' : blocker;
}

/** The workspace's task activities that have a task (decision 4): Activity.workspace is frozen at creation, so it is where the activity lives
 * even after a rule moved the task. A kept activity is cleaned through its worktree row, as the worktrees tab does. */
export function heldActivities(state: HeldState, name: string): HeldActivity[] {
  return state.activities.flatMap((activity): HeldActivity[] => {
    const task = activity.kind === 'task' && activity.workspace === name ? taskOfActivity(state, activity.id) : undefined;
    if (task === undefined) return [];
    const held = { activityId: activity.id, task: { id: taskId(task), title: taskLabel(task) } };
    const reason = holdingBlocker(task, activity, state);
    const entry: HeldActivity = reason === undefined ? { ...held, removable: true } : { ...held, removable: false, reason };
    return [entry];
  });
}

/** The tasks with no activity whose own workspace is the name (decision 6): one a rule places resolves again once the workspace is gone. */
export const heldTasks = (state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, name: string): { id: string; title: string }[] =>
  state.tasks.filter((task) => task.workspace === name && activityOf(state, taskId(task)) === undefined).map((task) => ({ id: taskId(task), title: taskLabel(task) }));

/** A worker runs in one of the workspace's activities (decision 3), its local one included: the dialog never offers a removal meanwhile. */
export const isRunningIn = (state: Pick<State, 'workers' | 'activities'>, name: string): boolean =>
  state.activities.some((activity) => activity.workspace === name && workersIn(state.workers, activity.id).length > 0);

const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

export type HoldingsRouteDeps = Pick<WorktreeRouteDeps, 'exec' | 'log' | 'requireLive'>;

// Decision 1: what delete activity would refuse. refuseUnmerged's rule (the upstream, or HEAD), then the PRs for a squash merge; a refusal
// that is not unmerged is git failing, the route's 500
async function unmergedOf(repo: string, row: WorktreeRow, prs: readonly TaskPr[], { exec, log }: HoldingsRouteDeps): Promise<UnmergedBranch[]> {
  const { branch } = row;
  if (branch === null) return []; // detached: no branch to refuse
  try {
    await refuseUnmerged(repo, branch, exec);
    return [];
  } catch (err) {
    const refusal = err instanceof RemovalRefusal ? err.refusal : undefined;
    if (refusal?.reason !== 'unmerged') throw err;
    return (await mergedByPr(repo, branch, prs, exec, log)) === undefined ? [{ slug: row.slug, branch, target: refusal.target }] : [];
  }
}

// The PRs delete activity passes (#660): the owning task's record's; an orphan passes none, a kept activity's record too (decision 1)
const prsOfRow = (state: Pick<State, 'activityRecords'>, row: WorktreeRow): readonly TaskPr[] =>
  (row.task === undefined ? [] : recordOf(state, row.task.activityId)?.prs ?? []);

async function holdingsOf(workspace: Workspace, state: State, deps: HoldingsRouteDeps): Promise<WorkspaceHoldings> {
  const worktrees = await workspaceRows(workspace, state, deps.exec); // decision 7: GET /worktrees' rows
  const branches = await Promise.all(worktrees.map((row) => unmergedOf(workspace.path, row, prsOfRow(state, row), deps))); // the listing's order
  const { name } = workspace;
  return { activities: heldActivities(state, name), worktrees, branches: branches.flat(), tasks: heldTasks(state, name), running: isRunningIn(state, name) };
}

/** GET /workspaces/:name/holdings (#750): what a saved workspace still holds, for its removal dialog (#751), read from the state and git on
 * demand, never kept. Any git failure is a 500 `unexpected` with git's words in hive.log (#660's rule); a failing gh read only counts as
 * not merged. */
export function registerHoldingsRoute(app: Express, deps: HoldingsRouteDeps): void {
  app.get('/workspaces/:name/holdings', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const name = String(req.params.name);
    const workspace = workspaceByName(current.runtime.config, name); // a name from the URL is only looked up, never a path (#179)
    if (!workspace) return void res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_WORKSPACE_MESSAGE });
    try {
      res.json(await holdingsOf(workspace, current.state, deps));
    } catch (err) {
      deps.log.error(`holdings ${name}: ${wordsOf(err)}`);
      res.status(HTTP_SERVER_ERROR).json({ error: UNEXPECTED });
    }
  });
}
