import type { MachineFor } from './machine.js';
import { registerStartRoute } from './server-start.js';
import { registerDeleteActivityRoute, removeCreatedWorktree } from './activity-delete.js';
import type { Express, Request, Response } from 'express';
import { activityOf, otherSlugs, } from './activities.js';
import { createTask, UNKNOWN_STAGE_MESSAGE, UNKNOWN_WORKSPACE_MESSAGE } from './create-task.js';
import type { ReportRetry } from './source-errors.js';
import { branchFor, inFlow, slugFor, canOpenSession, canRemoveCreated, canSetWorkspace, stageOf, type RemovalBlocker, removalBlocker, spawnedRun } from './tasks.js';
import { taskWorkspace, noWorkspaceReason, noWorkspaceFields, workspaceByName } from './config.js';
import { workspaceBase } from './fork.js';
import { LOCAL_BASES, } from './server-local.js';
import type { PluginRender } from './plugin-render.js';
import type { ReviewStore } from './review-store.js';
import { registerDiffRoutes } from './server-diff.js';
import { registerReviewRoutes } from './server-review.js';
import { registerTreeRoutes } from './server-tree.js';
import { registerSearchRoutes } from './server-search.js';
import { registerReplaceRoute } from './server-search-replace.js';
import { registerTreeWatchRoutes } from './server-tree-watch.js';
import type { TreeWatch } from './tree-watch.js';
import { registerMoveRoutes } from './server-move.js';
import { registerTreeOpsRoutes } from './server-tree-ops.js';
import { registerFileRoutes } from './server-files.js';
import { registerEditorRoutes } from './server-editor.js';
import { registerCheckRoutes } from './server-check.js';
import { registerFileBaseRoutes } from './server-file-base.js';
import { registerCopyRoutes } from './server-copy.js';
import { registerSessionRoutes } from './server-sessions.js';
import { registerDismissErrorRoute, registerRetryRoute } from './server-retry.js';
import { registerFlowRoutes } from './server-task-flow.js';
import type { Activity, AgentAvailability, BaseOptions, Source, Task, Config, CreatedRef, Effect, Exec, HiveEvent, Language, Workspace, State } from './types.js';
import { baseOptions, } from './worktree.js';
import type { Logger } from './log.js';
import type { ConsoleStore } from './console.js';
import type { PtyHost } from './pty-host.js';
import type { FactLog } from './facts.js';
import type { TerminalSize } from './terminal-wire.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409; // not configured, or the state refuses what was asked
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502; // the source failed a read the UI asked for
const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;
export const UNKNOWN_TASK_MESSAGE = 'tarefa desconhecida';
const TASK_ON_SOURCE_MESSAGE = 'tarefa ainda está na source';
export const RUNNING_MESSAGE = 'tarefa já está executando';
export const SETUP_RUNNING_MESSAGE = 'o setup desta tarefa ainda está em andamento'; // #351: one worktree, one setup at a time
export const LEAVING_MESSAGE = 'tarefa saindo da source'; // #491: an archive, remove or delete of the source is in flight on it (#286)
const DIFFERENT_STAGES_MESSAGE = 'tarefas em etapas diferentes';
export const OUTSIDE_FLOW_MESSAGE = 'the task is outside the flow: move it into a stage first'; // #566
export const DELETING_MESSAGE = 'atividade sendo excluída'; // a delete-activity stage or route is running git on it (#573)
const AUTO_BODY_MESSAGE = 'auto precisa ser true ou false';
const NOTHING_TO_DELETE_MESSAGE = 'nada para excluir'; // #236: no worktree, and no session the scope drops, outside a delete-activity stage
const WORKSPACE_LOCKED_MESSAGE = 'delete the activity first'; // canSetWorkspace: the worktree, its branch and its sessions live in the old repo
const NEEDS_WORKSPACE: BaseOptions = { hasWorktree: false, defaultRef: '', tasks: [], local: [], remote: [], needsWorkspace: true };
// The 409 for each reason the delete activity button's tooltip names (#210): one lookup, so the route and the button cannot disagree.
const REMOVAL_MESSAGE: Record<RemovalBlocker, string> = {
  running: RUNNING_MESSAGE, deleting: DELETING_MESSAGE, nothingToDelete: NOTHING_TO_DELETE_MESSAGE,
};

export interface Refusal { status: number; message: string; ref?: CreatedRef; code?: string; workspace?: string; resetsAt?: string; machine?: string; reason?: string } // #812: a source's rate limit, when to retry; #767/#811: the item a failed create left behind; #748: a gone workspace's code and name; #931: an unavailable machine's id and why

export interface TaskRouteDeps {
  machineFor: MachineFor; // #158: the activity's machine; #159, #160 and #161 read it
  reportRetry: ReportRetry; // #812: a create the source rate limited puts the source in backoff
  treeWatch: Pick<TreeWatch, 'lease' | 'release' | 'watchNested'>; // #502: the files sidebar's leases; the folder route registers the nested repositories it reads (#1)
  exec: Exec; // git for the base popup (#131) and the delete-activity route (#182, #573); tests inject a fake
  log: Pick<Logger, 'debug' | 'error' | 'info' | 'warn'>; // the transcripts' deletion (#236): a file already gone at debug, a failure at error; the worktree setup's steps at info (#299); a failed create's source words at warn (#772)
  /** The live runtime comes with the state: agentArgs, the branch template, the base branch and the Comb's prefix are read at
   * call time, a POST /settings may have changed them; the source is the live one. */
  requireLive(res: Response): {
    state: State;
    runtime: { config: Pick<Config, 'agentArgs' | 'agentEnabled' | 'branch' | 'baseBranch' | 'comb' | 'editor'>; sources: ReadonlyMap<string, Pick<Source, 'comments' | 'create'>>; promptsDir: string };
  } | undefined;
  dispatch(event: HiveEvent, size?: TerminalSize): Promise<Effect[]>; // #808: size, the page's grid, reaches only the spawns this event causes
  language(): Language; // the Hive's effective language, the config's else the system's: a kept-both item's " - copy" suffix (#594)
  agents: readonly AgentAvailability[]; // the agent CLIs found on boot (#516): a start's picked agent must be one (#290)
  /** The pool's own started(ptyId) (#249): resolves once the run's pty exists (#251), rejects on a spawn failure or an unknown id.
   * What POST /tasks/:id/open and POST /activities/:id/sessions/:session/open await before answering the run they just started. */
  started(ptyId: string): Promise<void>;
  reviews: ReviewStore; // each task's review file (#591): the diff route drops its stale marks, the review routes read and write it
  notifyReview(taskId: string): void; // the named `review` event on /events after every write (#591)
  ptys: Pick<PtyHost, 'adopt' | 'subscribe'>; // a delete's teardown run (#654), and a first open's setup run (#351)
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  poll(names: string[], manual?: string[]): Promise<void>; // #846: the poll loop's one-source path, after a task is created on a source; manual: items born with auto off
  latest(): State | undefined; // #846: the state after that poll
  facts?: Pick<FactLog, 'write'>; // #742: a delete's teardown steps and a first open's setup steps to worktree.step
  plugin: Pick<PluginRender, 'dir' | 'ready'>; // #316: each workspace's plugin folder: a session's specialized agents are read from its workspace's
}

export type LiveView = NonNullable<ReturnType<TaskRouteDeps['requireLive']>>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Why a close would be a no-op in the reducer: a source task closes once it is out of the listing or orphan (#568), a local one (#132) once it stopped. */
function closeRefusal(state: State, itemId: string): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (activityOf(state, itemId)?.deleting) return { status: HTTP_CONFLICT, message: DELETING_MESSAGE }; // git is removing its worktree (#182)
  if (task.outOfListing !== undefined || task.orphan || canRemoveCreated(task, state)) return undefined;
  if (!task.created) return { status: HTTP_CONFLICT, message: TASK_ON_SOURCE_MESSAGE };
  return { status: HTTP_CONFLICT, message: RUNNING_MESSAGE }; // a run of any kind holds it (#164, #283); deleting was refused above
}

export const refuse = (res: Response, refusal: Refusal): void => {
  // #767: a failed create that left an issue says which, so the client does not retry it into a second one. #748: a gone workspace's code and name, which the page words; undefined drops out of the JSON
  res.status(refusal.status).json({ error: refusal.message, code: refusal.code, workspace: refusal.workspace, machine: refusal.machine, reason: refusal.reason, ...(refusal.ref === undefined ? {} : { ref: refusal.ref }), ...(refusal.resetsAt === undefined ? {} : { resetsAt: refusal.resetsAt }) });
};

/** The task's workspace, or the route's answer when it has none (#179): 409 when the name it holds is gone, 400 when no rule answers one. */
export function workspaceOf(config: Pick<Config, 'comb'>, task: Task, tasks: readonly Task[] = []): Workspace | Refusal {
  return taskWorkspace(config, task, tasks) ?? { status: task.workspace === undefined ? HTTP_BAD_REQUEST : HTTP_CONFLICT, message: noWorkspaceReason(task), ...noWorkspaceFields(task) };
}

/** A workspace the body names for a task (#179): a Comb workspace, on a task whose workspace may still change. */
function chosenWorkspace(state: State, task: Task, raw: unknown): string | Refusal {
  if (typeof raw !== 'string' || !state.workspaces.includes(raw)) return { status: HTTP_BAD_REQUEST, message: UNKNOWN_WORKSPACE_MESSAGE };
  return canSetWorkspace(task, state) ? raw : { status: HTTP_CONFLICT, message: WORKSPACE_LOCKED_MESSAGE };
}

// The task as the body would place it (#179): unchanged without `workspace`, else with the checked choice. Also server-open.ts's first open (#351).
export function placedTask(state: State, task: Task, raw: unknown): Task | Refusal {
  if (raw === undefined) return task;
  const workspace = chosenWorkspace(state, task, raw);
  return typeof workspace === 'string' ? { ...task, workspace } : workspace;
}

/** The task an open session acts on, or why not (#283): unknown, gone from the source, its worktree being removed (#182), its setup running
 * (#351) or leaving the source (#286). A blocked task opens (#491): a blocker holds the stage run, not what the user opens by hand. */
export function openTask(state: State, itemId: string): { task: Task; activity?: Activity } | Refusal {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  const activity = activityOf(state, itemId);
  if (activity?.deleting) return { status: HTTP_CONFLICT, message: DELETING_MESSAGE }; // no terminal, session or worktree while git removes it (#182)
  if (activity?.setup) return { status: HTTP_CONFLICT, message: SETUP_RUNNING_MESSAGE }; // a second open, a run command or a session while it sets up (#351)
  if (!canOpenSession(task, activity)) return { status: HTTP_CONFLICT, message: LEAVING_MESSAGE }; // the checks above leave only leaving
  return activity ? { task, activity } : { task };
}

/** Why the delete activity button would be a no-op in the reducer (removalBlocker, one message each), or the task. */
export function removalRefusal(state: State, itemId: string): Refusal | Task {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  const blocker = removalBlocker(task, state);
  return blocker ? { status: HTTP_CONFLICT, message: REMOVAL_MESSAGE[blocker] } : task;
}

// A `before` that names no task (404) or a task outside `stage` (409): shared by the reorder and the move to (#366).
export function beforeRefusal(state: State, before: string, stage: string): Refusal | undefined {
  const target = state.tasks.find((c) => c.item.itemId === before);
  if (!target) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  return target.stage === stage ? undefined : { status: HTTP_CONFLICT, message: DIFFERENT_STAGES_MESSAGE };
}

/** Why a move would be a no-op in the reducer: unknown task, unknown target, or a target in another stage (a reorder stays in its stage;
 * crossing stages is move-to's, #366). */
function moveRefusal(state: State, itemId: string, before: string | undefined): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (!inFlow(task)) return { status: HTTP_CONFLICT, message: OUTSIDE_FLOW_MESSAGE }; // #566: no stage to order in
  return before === undefined ? undefined : beforeRefusal(state, before, task.stage);
}

// The human override on a stopped task (start), the remove of a task out of the listing or an orphan (close), the removal of a stopped task's worktree (delete-activity) and the Hive's own order
// (move / reset-order). The checks answer what the reducer would ignore in silence, so the UI is never left without an answer; a race between the check and the dispatch is a no-op in the
// reducer, never a spawn or a close it should not do.
export function registerTaskRoutes(app: Express, deps: TaskRouteDeps): void {
  const { requireLive, dispatch } = deps;

  registerStartRoute(app, deps);

  app.post('/tasks/:id/close', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const refusal = closeRefusal(current.state, taskId);
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.message });
      return;
    }
    const removal = await removeCreatedWorktree(deps, current, taskId); // #542: git before the task goes
    if (typeof removal === 'object') return refuse(res, removal);
    if (removal === undefined) await dispatch({ type: 'closeTask', taskId });
    res.json({ ok: true });
  });

  registerCreateRoute(app, deps);
  registerCommentsRoute(app, deps);
  registerOrderRoutes(app, deps);
  registerBaseRoute(app, deps);
  registerDeleteActivityRoute(app, deps);
  registerAutoRoutes(app, deps);
  registerFlowRoutes(app, deps); // POST /tasks/:id/move-to (#366) and /leave-flow (#566)
  registerRetryRoute(app, deps); // POST /tasks/:id/retry (#915)
  registerDismissErrorRoute(app, deps); // POST /tasks/:id/dismiss-error (#354)
  registerSessionRoutes(app, deps);
  registerCopyRoutes(app, deps); // GET, POST …/sessions/:session/copy (#587)
  registerWorkspaceRoute(app, deps);
  registerFileRoutes(app, deps);
  registerEditorRoutes(app, deps); // GET, PUT /activities/:id/file and GET …/file-version: the editor pane (#717)
  registerCheckRoutes(app, deps); // POST /activities/:id/check/:checker and GET /settings/checkers: the command-line checkers (#782)
  registerFileBaseRoutes(app, deps); // GET /activities/:id/file-base: what a file's changes compare against (#668)
  registerDiffRoutes(app, deps); // GET /activities/:id/diff (#270)
  registerReviewRoutes(app, deps); // GET /tasks/:id/review and the reviewed marks (#591)
  registerTreeRoutes(app, deps); // GET /activities/:id/tree, POST /activities/:id/reveal (redesign 07), GET /activities/:id/tree/folder (HIVE-22)
  registerSearchRoutes(app, deps); // GET /activities/:id/search, the busca pane (#868)
  registerReplaceRoute(app, deps); // POST /activities/:id/search/replace (#868)
  registerTreeWatchRoutes(app, deps); // POST, DELETE /activities/:id/tree/watch: the files sidebar's lease (#502)
  registerMoveRoutes(app, deps); // POST /activities/:id/tree/move, the file tree's drop (#594)
  registerTreeOpsRoutes(app, deps); // POST /activities/:id/tree/create, /rename, /trash, /file: the files tree's own operations (#818)
}

// Right-click › Workspace (#179): a task's workspace by hand, only while it is stopped and has no worktree. The fill may start it at once.
function registerWorkspaceRoute(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/tasks/:id/workspace', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const task = current.state.tasks.find((c) => c.item.itemId === taskId);
    if (!task) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE });
    const workspace = chosenWorkspace(current.state, task, (req.body as { workspace?: unknown } | undefined)?.workspace);
    if (typeof workspace !== 'string') return refuse(res, workspace);
    await dispatch({ type: 'setWorkspace', taskId, workspace });
    res.json({ ok: true });
  });
}

// The Hive's own order of a stage: a task dropped before another (or on the stage's tail: no before), and the way back to the source's order.
// Neither writes to the source; the reducer only reorders State.tasks and fills.
function registerOrderRoutes(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/tasks/:id/move', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const raw = (req.body as { before?: unknown } | undefined)?.before;
    const before = typeof raw === 'string' ? raw : undefined; // anything else is "end of the stage"
    const refusal = moveRefusal(current.state, taskId, before);
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.message });
      return;
    }
    await dispatch({ type: 'moveTask', taskId, before });
    res.json({ ok: true });
  });

  app.post('/stages/:name/reset-order', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const stage = req.params.name as string;
    if (stageOf(current.state.stages, stage) === undefined) {
      res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_STAGE_MESSAGE });
      return;
    }
    await dispatch({ type: 'resetOrder', stage });
    res.json({ ok: true });
  });
}

// The task's comments, read from the source when the panel opens on it: never by the poll, never stored, never dispatched. A source
// without comments answers null so the panel hides the section; a source failure is a 502 the panel shows inline
// (github-gql already keeps the token out of the message).
function registerCommentsRoute(app: Express, { requireLive }: TaskRouteDeps): void {
  app.get('/tasks/:id/comments', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const itemId = req.params.id as string;
    const task = current.state.tasks.find((c) => c.item.itemId === itemId);
    if (!task) {
      res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_TASK_MESSAGE });
      return;
    }
    const source = task.item.source === undefined ? undefined : current.runtime.sources.get(task.item.source); // the task's own source (#180)
    if (task.created || !source?.comments) { // a local task (#132), a removed source (#180) or one without comments
      res.json(null);
      return;
    }
    try {
      res.json(await source.comments(itemId));
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });
}

// Where the popup's lists come from (#179): the task's workspace; a task with none and no name yet needs one (needsWorkspace); `?workspace=`
// names the popup's choice. A name the task holds but the Comb lost is its 409.
function basesWorkspace(current: LiveView, task: Task, query: unknown): Workspace | Refusal | typeof NEEDS_WORKSPACE {
  const own = workspaceOf(current.runtime.config, task, current.state.tasks);
  if (!('status' in own) || task.workspace !== undefined) return own;
  if (typeof query !== 'string') return NEEDS_WORKSPACE;
  return workspaceByName(current.runtime.config, query) ?? { status: HTTP_BAD_REQUEST, message: UNKNOWN_WORKSPACE_MESSAGE };
}


// The popup's lists (#131). Read-only, no fetch, so it opens at once; a task that already has its worktree answers hasWorktree and the
// UI starts it straight away. The other tasks go by slug: the branch shown is the one git lists at each task's worktree path.
function registerBaseRoute(app: Express, { machineFor, requireLive }: TaskRouteDeps): void {
  app.get('/tasks/:id/bases', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const task = current.state.tasks.find((c) => c.item.itemId === req.params.id);
    if (!task) {
      res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_TASK_MESSAGE });
      return;
    }
    const activity = activityOf(current.state, task.item.itemId);
    if (activity?.local) return void res.json(LOCAL_BASES); // #444: it runs in the checkout; no popup reopens to flip it back
    const workspace = basesWorkspace(current, task, req.query.workspace);
    if ('hasWorktree' in workspace) return void res.json(NEEDS_WORKSPACE); // basesWorkspace only ever answers NEEDS_WORKSPACE itself here
    if ('status' in workspace) return refuse(res, workspace);
    const others = otherSlugs(current.state, activity);
    try {
      const orphanBranch = activity === undefined ? branchFor(current.runtime.config, task.item) : undefined; // #861: no activity: git's leftovers are an orphan
      res.json(await baseOptions(machineFor(activity ?? workspace), workspace.path, activity?.slug ?? slugFor(task.item), others, workspaceBase(current.runtime.config, workspace), orphanBranch));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) }); // git's own words: not a repo, a broken worktree list
    }
  });
}

// A task created in the Comb (#132) or on a source (#846): from the stage header's `+`, or from any local process that speaks HTTP (a Claude
// session fed by another tool's MCP); like every dashboard POST it needs the x-hive-ui header. createTask picks the destination.
function registerCreateRoute(app: Express, { requireLive, dispatch, poll, latest, log, reportRetry }: TaskRouteDeps): void {
  app.post('/tasks', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const { config, sources } = current.runtime;
    const created = await createTask({ state: current.state, config, sources, dispatch, poll, latest, log, reportRetry }, req.body);
    if ('status' in created) return refuse(res, created);
    res.status(HTTP_CREATED).json(created); // itemId: what the new activity dialog starts it by
  });
}

// The auto switch (#164, #573): out of or back into the orchestrator's hands. It does not touch git; the move to another stage by hand
// (#366, #708) is registerFlowRoutes'.
function registerAutoRoutes(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/tasks/:id/auto', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const auto = (req.body as { auto?: unknown } | undefined)?.auto;
    const task = current.state.tasks.find((c) => c.item.itemId === taskId);
    if (!task) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE });
    if (typeof auto !== 'boolean') return refuse(res, { status: HTTP_BAD_REQUEST, message: AUTO_BODY_MESSAGE });
    await dispatch({ type: 'setAuto', taskId, auto });
    res.json({ ok: true });
  });
}

/** The answer POST /tasks/:id/open and POST /activities/:id/sessions/:session/open give once their dispatch has run (#249): the run openSession
 * just started (spawnedRun), once the pool's started(ptyId) confirms its pty exists, so the page can attach it at once with
 * no extra click on terminal. Plain ok when openSession emitted no run (canOpenSession already refused it, or a race did) or the spawn
 * itself failed: the error bar already shows that through spawnFailed, and the page then attaches nothing.
 */
export async function answerOpen(deps: Pick<TaskRouteDeps, 'started'>, effects: Effect[], res: Response): Promise<void> {
  const run = spawnedRun(effects);
  if (!run) {
    res.json({ ok: true });
    return;
  }
  try {
    await deps.started(run.ptyId);
    res.json({ ok: true, ...run });
  } catch {
    res.json({ ok: true });
  }
}
