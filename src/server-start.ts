// The start route, out of server-tasks.ts (#159): POST /tasks/:id/start with its refusals.
import type { Express, Request, Response } from 'express';
import { activityOf } from './activities.js';
import { branchFor, inFlow, inAction, stageOf, isBlocked } from './tasks.js';
import { hiveAction, runsAgent } from './stage-agent.js';
import { baseRemote } from './fork.js';
import { discardOrphan } from './server-orphan.js';
import { AWAITING_MESSAGE } from './server-approval.js';
import { startLocal } from './server-local.js';
import { parseRunPick } from './run-pick.js';
import { checkBase } from './worktree.js';
import { sizeIn } from './terminal-wire.js';
import { hostOnlyRefusal } from './benchmark-guards.js';
import { machineRefusal } from './machines.js'; // #931: a workspace on a machine the registry cannot serve is refused before anything is dispatched
import type { HiveEvent, State, Task } from './types.js';
import {
  DELETING_MESSAGE, OUTSIDE_FLOW_MESSAGE, RUNNING_MESSAGE, SETUP_RUNNING_MESSAGE, UNKNOWN_TASK_MESSAGE,
  placedTask, refuse, workspaceOf, type LiveView, type Refusal, type TaskRouteDeps,
} from './server-tasks.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const EPIC_MESSAGE = 'um épico não executa: sua etapa vem das filhas'; // #31: a show epic; the reducer's start ignores it
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Why a manual start refuses a blocked task (#283): its own blockers, then each inherited one with the ancestor that holds it (#424). An
 * open no longer does (#491): a blocker holds the stage run only. */
export const blockedMessage = (task: Task): string => {
  const inherited = (task.item.inheritedBlockedBy ?? []).map((b) => `${b.id} (via ${b.via})`);
  return `task bloqueado por ${[...(task.item.blockedBy ?? []), ...inherited].join(', ')}`;
};

/** Why a manual start would be a no-op in the reducer, as the answer the route gives; undefined when it can go through. No free worker is
 * not a refusal: the reducer opens one over the cap (#116). */
function startRefusal(state: State, itemId: string): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (task.item.epic !== undefined) return { status: HTTP_CONFLICT, message: EPIC_MESSAGE };
  if (!inFlow(task)) return { status: HTTP_CONFLICT, message: OUTSIDE_FLOW_MESSAGE }; // #566: /start runs a stage; the Start dialog moves it first (3.5)
  const activity = activityOf(state, itemId);
  if (activity?.setup) return { status: HTTP_CONFLICT, message: SETUP_RUNNING_MESSAGE }; // before RUNNING: both paths answer the same (#351)
  if (activity?.workerId !== undefined || inAction(activity)) return { status: HTTP_CONFLICT, message: RUNNING_MESSAGE }; // #755, #834: a stage action runs
  if (activity?.deleting || activity?.approval) return { status: HTTP_CONFLICT, message: activity?.deleting ? DELETING_MESSAGE : AWAITING_MESSAGE }; // the reducer ignores both (#268)
  const stage = stageOf(state.stages, task.stage);
  if (hiveAction(stage) !== undefined) return undefined; // a git command of the Hive or the workspace's commands (#755): no worker, no blockers, no prompt
  if (isBlocked(task.item)) return { status: HTTP_CONFLICT, message: blockedMessage(task) };
  if (stage === undefined || !runsAgent(stage)) return { status: HTTP_CONFLICT, message: 'etapa sem prompt' }; // #710: a skill stage runs one
  return undefined;
}

/** The start the body asks for. `base: null` is the popup's default and drops a saved base. No string base, or a delete activity stage (which
 * never gets one): today's start. A base must be a branch git has and not the task's own (#131), else the answer is a 409 with the
 * reason and nothing starts. The body's workspace is checked like right-click › Workspace and saved with the start (#179). The body's run picks
 * (#290) are checked by parseRunPick and travel with the event. */
async function startEvent(deps: TaskRouteDeps, current: LiveView, itemId: string, body: unknown): Promise<Extract<HiveEvent, { type: 'start' }> | Refusal> {
  const { base, tellWorker, workspace: raw } = (body ?? {}) as { base?: unknown; tellWorker?: unknown; workspace?: unknown };
  const found = current.state.tasks.find((c) => c.item.itemId === itemId);
  if (!found) return { type: 'start', itemId };
  const task = placedTask(current.state, found, raw);
  if ('status' in task) return task;
  const workspace = workspaceOf(current.runtime.config, task, current.state.tasks); // #179: a task with no workspace is refused here, never a silent no-op
  if ('status' in workspace) return workspace;
  // #932: an evaluate stage's agents run on this computer: refused before any machine call or dispatch
  const remote = stageOf(current.state.stages, task.stage)?.action === 'evaluate' ? hostOnlyRefusal(workspace) : undefined;
  if (remote) return remote;
  const machine = deps.machineFor(activityOf(current.state, itemId) ?? workspace); // a live activity's machine is frozen; else the workspace's
  const unavailable = await machineRefusal(machine, workspace.path);
  if (unavailable) return unavailable;
  await deps.plugin.ready(); // #316: a render a save queued lands before the picks read the folder
  const picked = parseRunPick(body, current.state, task, deps.agents, deps.language(), () => deps.plugin.dir(workspace.name), current.runtime.config.agentEnabled); // #290: the run picks, before any git; #316: its workspace's agents
  if ('status' in picked) return picked;
  const placed = { ...(raw === undefined ? {} : { workspace: task.workspace }), ...picked };
  if (stageOf(current.state.stages, task.stage)?.action === 'deleteActivity') return { type: 'start', itemId, ...placed };
  if (base === null) return { type: 'start', itemId, base: null, ...placed }; // the popup's default: drops a saved base
  if (typeof base !== 'string') return { type: 'start', itemId, ...placed };
  try {
    await checkBase(machine, workspace.path, base, branchFor(current.runtime.config, task.item), baseRemote(workspace));
  } catch (err) {
    return { status: HTTP_CONFLICT, message: errorMessage(err) };
  }
  return { type: 'start', itemId, base: { ref: base, tellWorker: tellWorker === true }, ...placed };
}

export function registerStartRoute(app: Express, deps: TaskRouteDeps): void {
  const { requireLive, dispatch } = deps;
  app.post('/tasks/:id/start', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const itemId = req.params.id as string;
    const refusal = startRefusal(current.state, itemId);
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.message });
      return;
    }
    const event = await startEvent(deps, current, itemId, req.body); // an old client's { raiseMax } is ignored
    if ('status' in event) return refuse(res, event); // #748: workspaceOf's code and name with it
    const discarded = await discardOrphan(deps, current, itemId, req.body); // #861: before the start, so its worktree is made from the base
    if (discarded) return void res.status(discarded.status).json({ error: discarded.error, code: discarded.code });
    const found = current.state.tasks.find((c) => c.item.itemId === itemId);
    await dispatch({ ...event, ...(found ? startLocal(req.body, activityOf(current.state, itemId)) : {}) }, sizeIn(req.body)); // the popup's switch (#444): the reducer writes it next to the base, a delete activity stage ignores it; #808: the page's grid
    res.json({ ok: true });
  });
}
