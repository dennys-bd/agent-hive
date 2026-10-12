import { existsSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import { activityOf } from './activities.js';
import { AGENTS, agentName, knownAgent } from './agents.js';
import { activityParam, taskTarget } from './activity-routes.js';
import { taskWorkspace } from './config.js';
import { baseRemote, workspaceBase } from './fork.js';
import { taskBranch } from './task-runs.js';
import { openWorktreeRun } from './task-setup.js';
import { setupRunId } from './console.js';
import { branchFor, slugFor, slugOwner, slugTakenMessage, worktreeSessions } from './tasks.js';
import { answerOpen, type TaskRouteDeps, type LiveView, openTask, placedTask, workspaceOf, type Refusal, refuse, RUNNING_MESSAGE, SETUP_RUNNING_MESSAGE } from './server-tasks.js';
import { openPlace } from './server-local.js';
import { sizeIn, type TerminalSize } from './terminal-wire.js';
import { AGENT_IDS, type Activity, type AgentId, type Effect, type Language, type Task, type HiveEvent, type Workspace } from './types.js';
import { checkBase, ensureCheckout, ensureWorktree, worktreePath } from './worktree.js';
import { isSetUp } from './worktree-setup.js';
import { clearTeardownMarker } from './worktree-teardown.js';
import { isBranchName, MERGE_BASE_PROMPT, mergeBasePrompt } from './merge-prompt.js';
import { MESSAGES } from './ui/i18n.js';

// Abrir sessão (#164, #237, #283), out of server-tasks.ts, which was over its size, when a first open's worktree setup became a state of
// the task with a console run (#351).

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const KIND_MESSAGE = `kind precisa ser terminal ou ${AGENT_IDS.join(', ')}`; // #925: every agent AGENT_IDS has
const NOT_CONTINUABLE_MESSAGE = 'sessão já aberta ou desconhecida';
const PROMPT_MESSAGE = 'prompt must be mergeBase, with promptBase a branch name, on a new agent session';

/** #927: a new session of an agent that picks its own session id (Codex) is refused until #931: an open names its id up front, so sleep, wake
 * and continue would break. In the Hive's effective language: the daemon never sets the page's. A resume is not a new session. */
export function newSessionRefusal(agent: AgentId, language: Language): Refusal | undefined {
  if (AGENTS[agent].canChooseSessionId) return undefined;
  return { status: HTTP_BAD_REQUEST, message: MESSAGES[language]['open.agentUnavailable'].replaceAll('{agent}', agentName(agent)) };
}

/** The open route's deps (#351): the task routes' own, and what a worktree setup's console run needs. */
export type OpenRouteDeps = TaskRouteDeps; // ptys and consoleStore came with the delete's teardown (#654)

type OpenEvent = Extract<HiveEvent, { type: 'openSession' | 'openTerminal' }>;
/** What an open asks for, before its activity is known (#629): a first open makes it. #570: a terminal is not a session, so it has its own event.
 * prompt: the rendered first message of a new agent session (#758). agent: the session's, the kind asked for (#925). */
interface OpenAsk { taskId: string; terminal: boolean; agent?: AgentId; continueId?: string; prompt?: string; size?: TerminalSize }

const openEvent = ({ terminal, agent, continueId, prompt }: OpenAsk, activityId: string): OpenEvent =>
  (terminal ? { type: 'openTerminal', activityId } : {
    type: 'openSession', activityId, ...(agent === undefined ? {} : { agent }), ...(continueId === undefined ? {} : { continueId }), ...(prompt === undefined ? {} : { prompt }),
  });

// The first prompt an open asks for (#758): a key, never text, rendered here; none without one; a 400 for anything but mergeBase with a
// branch name on a new agent session
function promptOf(body: unknown, remote: string): { prompt?: string } | Refusal {
  const { kind, continueId, prompt, promptBase } = (body ?? {}) as Record<string, unknown>;
  if (prompt === undefined) return {};
  if (prompt !== MERGE_BASE_PROMPT || knownAgent(kind) === undefined || continueId !== undefined || !isBranchName(promptBase)) return { status: HTTP_BAD_REQUEST, message: PROMPT_MESSAGE };
  return { prompt: mergeBasePrompt(promptBase, remote) }; // #854: the task's workspace's base remote
}

/** Where a first open makes the task's worktree, as its checks settled it: the task as placed (#179), its workspace, its slug, its branch and
 * its place, the popup's base and local switch (#444). */
interface WorktreePlan { task: Task; workspace: Workspace; slug: string; branch: string; place: ReturnType<typeof openPlace> }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The checks of a first open that run no git (#179, #180, #283, #444): the popup's workspace, the slug's owner, the branch a Restart moved it to.
function planWorktree(current: LiveView, task: Task, activity: Activity | undefined, body: unknown): WorktreePlan | Refusal {
  const { workspace: chosen } = (body ?? {}) as { workspace?: unknown };
  const placed = placedTask(current.state, task, chosen); // the popup's workspace (#179)
  if ('status' in placed) return placed;
  const workspace = workspaceOf(current.runtime.config, placed, current.state.tasks); // #32: as the reducer resolves it, before any freeze
  if ('status' in workspace) return workspace;
  const owner = slugOwner(current.state, placed, workspace.name); // #180: never one worktree and branch for two tasks
  const slug = activity?.slug ?? slugFor(task.item);
  if (owner) return { status: HTTP_CONFLICT, message: slugTakenMessage(slug, owner) };
  return { task: placed, workspace, slug, branch: taskBranch(activity, branchFor(current.runtime.config, task.item)), place: openPlace(body, activity) };
}

// A chosen base checked in the task's workspace (#131), then the workspace saved once it passed (#179): the last refusal, before any git that
// changes the disk.
async function confirmPlan(deps: TaskRouteDeps, task: Task, { task: placed, workspace, branch, place }: WorktreePlan): Promise<Refusal | undefined> {
  try {
    if (place.base !== undefined) await checkBase(workspace.path, place.base.ref, branch, deps.exec, baseRemote(workspace));
  } catch (err) {
    return { status: HTTP_CONFLICT, message: errorMessage(err) };
  }
  if (placed.workspace !== task.workspace && placed.workspace !== undefined) await deps.dispatch({ type: 'setWorkspace', taskId: task.item.itemId, workspace: placed.workspace });
  return undefined;
}

// The worktree, or the workspace's own checkout (#444), then `setUp` in it (#299, #351), then the task's worktree fields. The base is saved
// with tellWorker false: a session gets no stage prompt to tell.
async function makeWorktree(deps: TaskRouteDeps, current: LiveView, plan: WorktreePlan, activityId: string, setUp?: (path: string) => Promise<void>): Promise<void> {
  const { workspace, slug, branch, place } = plan;
  const base = workspaceBase(current.runtime.config, workspace); // #854
  const { path, sync } = place.local
    ? await ensureCheckout(workspace.path, branch, base, place.base?.ref, deps.exec)
    : await ensureWorktree(workspace.path, slug, branch, base, place.base?.ref, deps.exec);
  if (sync) await deps.dispatch({ type: 'forkSynced', activityId, sync }); // #854: an open's worktree keeps its sync as a spawn's does
  await setUp?.(path);
  await deps.dispatch({ type: 'worktreeReady', activityId, path, branch, base: place.base ?? null, local: place.local });
}

// The activity is born before the worktree's git and the setup's mark (#629), synchronously, in the same turn as the checks: dispatch reduces
// before its own first await, so neither a second open nor a start can land between the checks and the mark. The popup's workspace is saved
// first, so the activity is born in it.
function bornActivity(deps: OpenRouteDeps, res: Response, task: Task, plan: WorktreePlan): { activityId: string; settled: Promise<Effect[][]> } | undefined {
  const taskId = task.item.itemId;
  const moved = plan.task.workspace !== task.workspace && plan.task.workspace !== undefined;
  const placing = moved ? [deps.dispatch({ type: 'setWorkspace', taskId, workspace: plan.task.workspace ?? '' })] : [];
  const settled = Promise.all([...placing, deps.dispatch({ type: 'createActivity', taskId })]);
  const live = deps.requireLive(res);
  const activityId = live === undefined ? undefined : activityOf(live.state, taskId)?.id;
  return activityId === undefined ? undefined : { activityId, settled };
}

// The open's 409 when no activity came back (a race took the task); requireLive already answered when the Hive is not live
const noActivity = (res: Response): void => (res.headersSent ? undefined : refuse(res, { status: HTTP_CONFLICT, message: SETUP_RUNNING_MESSAGE }));

// The session on a task whose worktree is there (#164, #249): both kinds run in the task's workspace (#179), in its live activity, read again
// after any git (#629); the answer is the run to attach.
async function openNow(deps: TaskRouteDeps, current: LiveView, task: Task, open: OpenAsk, res: Response): Promise<void> {
  const workspace = workspaceOf(current.runtime.config, task, current.state.tasks);
  if ('status' in workspace) return refuse(res, workspace);
  const live = deps.requireLive(res);
  const activityId = live && activityOf(live.state, open.taskId)?.id;
  if (activityId === undefined) return noActivity(res);
  await answerOpen(deps, await deps.dispatch(openEvent(open, activityId), open.size), res);
}

// A first open that prepares the worktree (#351, #576), with or without setup steps. openWorktreeRun is synchronous, dispatch reduces before its own first await and nothing was
// awaited since openTask, so the mark lands in the same turn as the checks: a second open, Start, Continue or Restart is refused from here on,
// even while the base is checked. The run opens with the mark, so every git from the base check on is in it; a refused base ends it and drops
// the mark. The mark goes before the session opens, since canOpenSession refuses a task that sets up. A failure answers as before, and
// setupEnded's error keeps it on the task for a dialog the user closed.
async function openWithSetup(deps: OpenRouteDeps, current: LiveView, task: Task, plan: WorktreePlan, open: OpenAsk, res: Response): Promise<void> {
  const born = bornActivity(deps, res, task, plan);
  if (!born) return noActivity(res);
  const { activityId, settled } = born;
  const setup = openWorktreeRun(deps, { id: setupRunId(task.item.itemId), label: `#${plan.task.item.id}`, kind: 'setup', activityId });
  await Promise.all([settled, deps.dispatch({ type: 'setupStarted', activityId, consoleId: setup.id })]);
  const logged: OpenRouteDeps = { ...deps, exec: setup.exec };
  let refusal: Refusal | undefined;
  try { // everything after the mark: no throw may leave the task marked until the next boot
    refusal = await confirmPlan(logged, task, plan);
    if (!refusal) await makeWorktree(logged, current, plan, activityId, (path) => setup.setUp(plan.workspace, path));
  } catch (err) {
    setup.end(err);
    await deps.dispatch({ type: 'setupEnded', activityId, error: errorMessage(err) });
    return refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) }); // git's own words, or the failed step and reason (#299)
  }
  setup.end(refusal?.message);
  await deps.dispatch({ type: 'setupEnded', activityId });
  if (refusal) return refuse(res, refusal);
  await openNow(deps, current, plan.task, open, res);
}

// A worktree folder already on disk that still needs its setup (#351): the check awaited git, so the task is read again before the mark, as
// the route's own checks would: another open, a start or a setup may have taken it meanwhile.
async function openRechecked(deps: OpenRouteDeps, plan: WorktreePlan, open: OpenAsk, res: Response): Promise<void> {
  const fresh = deps.requireLive(res);
  if (!fresh) return;
  const opened = openTask(fresh.state, open.taskId);
  if ('status' in opened) return refuse(res, opened);
  const { task, activity } = opened;
  if (activity?.worktree !== undefined && !activity.worktreeGone) return openNow(deps, fresh, task, open, res);
  if (activity?.workerId !== undefined) return refuse(res, { status: HTTP_CONFLICT, message: RUNNING_MESSAGE });
  await openWithSetup(deps, fresh, task, plan, open, res);
}

// A first open (#164, #351, #576): the worktree made, then the session. A worktree it prepares gets the mark and the console run, with or
// without setup steps: one still to set up, or one whose folder is not there yet (new, or gone from disk and recreated), marked in the same
// turn as the checks with no git before it. A local task never sets up (#444), nor does a folder already set up: those make it unmarked.
async function openFirst(deps: OpenRouteDeps, current: LiveView, task: Task, plan: WorktreePlan, open: OpenAsk, res: Response): Promise<void> {
  if (!plan.place.local) {
    const path = worktreePath(plan.workspace.path, plan.slug);
    if (!existsSync(path)) return openWithSetup(deps, current, task, plan, open, res);
    await clearTeardownMarker(plan.workspace, path, deps.exec); // #654: a worktree brought back to life gets its teardown on the next removal
    if (!(await isSetUp(plan.workspace, path, deps.exec))) return openRechecked(deps, plan, open, res);
  }
  const refusal = await confirmPlan(deps, task, plan);
  if (refusal) return refuse(res, refusal);
  const born = bornActivity(deps, res, task, plan);
  if (!born) return noActivity(res);
  try {
    await born.settled;
    await makeWorktree(deps, current, plan, born.activityId);
  } catch (err) {
    return refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) }); // git's own words
  }
  await openNow(deps, current, plan.task, open, res);
}

// One open, on a task (#164, #237, #283): a first one makes the activity, a later one opens in it (#629). The request is checked before
// anything else, so a bad one never creates a worktree.
async function openOn(deps: OpenRouteDeps, current: LiveView, taskId: string, body: unknown, res: Response): Promise<void> {
  const { kind, continueId } = (body ?? {}) as { kind?: unknown; continueId?: unknown };
  const opened = openTask(current.state, taskId);
  if ('status' in opened) return refuse(res, opened);
  const { task, activity } = opened;
  const agent = knownAgent(kind); // #925: the kind names the session's agent
  if (kind !== 'terminal' && agent === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: KIND_MESSAGE });
  const unavailable = agent === undefined || continueId !== undefined ? undefined : newSessionRefusal(agent, deps.language());
  if (unavailable) return refuse(res, unavailable);
  const asked = promptOf(body, workspaceBase(current.runtime.config, taskWorkspace(current.runtime.config, task)).remote);
  if ('status' in asked) return refuse(res, asked);
  const offered = typeof continueId === 'string' && worktreeSessions(task, current.state).some((s) => s.id === continueId); // a repo session opens from the sidebar (#208)
  if (agent !== undefined && continueId !== undefined && !offered) return refuse(res, { status: HTTP_CONFLICT, message: NOT_CONTINUABLE_MESSAGE });
  const size = sizeIn(body);
  const open: OpenAsk = {
    taskId, terminal: agent === undefined, ...(agent === undefined ? {} : { agent }),
    ...(agent !== undefined && typeof continueId === 'string' ? { continueId } : {}), ...asked, ...(size === undefined ? {} : { size }),
  };
  if (activity?.worktree !== undefined && !activity.worktreeGone) return openNow(deps, current, task, open, res);
  // A stage spawn is still making this worktree (and its setup, in the same console channel): one maker at a time (#351).
  if (activity?.workerId !== undefined) return refuse(res, { status: HTTP_CONFLICT, message: RUNNING_MESSAGE });
  const plan = planWorktree(current, task, activity, body);
  if ('status' in plan) return refuse(res, plan);
  await openFirst(deps, current, task, plan, open, res);
}

/** Abrir sessão on any task (#164, #237, #283): the worktree first when the task has none or it is gone from disk (#208), then a terminal (openTerminal), or an
 * agent's session in a worker of its own (openSession, #925). A continueId is one of worktreeSessions. A worktree it prepares (#351, #576) marks the
 * task while its git and setup run; either way the answer is the run the page attaches (#249). A dialog closed meanwhile does not stop the
 * request. /tasks/:id/open is the first open, and on a task with a live activity the same as /activities/:id/open (#629), which a local
 * activity, with no task, refuses. */
export function registerOpenRoute(app: Express, deps: OpenRouteDeps): void {
  app.post('/tasks/:id/open', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    await openOn(deps, current, req.params.id as string, req.body, res);
  });
  app.post('/activities/:id/open', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const target = taskTarget(current.state, activityParam(req));
    if ('status' in target) return refuse(res, target);
    await openOn(deps, current, target.task.item.itemId, req.body, res);
  });
}
