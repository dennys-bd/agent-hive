import type { Express, Request, Response } from 'express';
import { activityOf, otherSlugs } from './activities.js';
import { activityParam, taskTarget } from './activity-routes.js';
import { createTask, UNKNOWN_STAGE_MESSAGE, UNKNOWN_WORKSPACE_MESSAGE } from './create-task.js';
import { branchFor, slugFor, canCloseMissing, canOpenSession, canMoveToStage, canRemoveCreated, canSetWorkspace, inAction, stageOf, isBlocked, nothingToDelete, type RemovalBlocker, removalBlocker, sessionsOf, spawnedRun } from './tasks.js';
import { taskWorkspace, noWorkspaceReason, workspaceByName } from './config.js';
import { baseRemote, workspaceBase } from './fork.js';
import { discardOrphan } from './server-orphan.js';
import { AWAITING_MESSAGE } from './server-approval.js';
import { LOCAL_BASES, LOCAL_MESSAGE, startLocal } from './server-local.js';
import type { ReviewStore } from './review-store.js';
import { registerDiffRoutes } from './server-diff.js';
import { registerReviewRoutes } from './server-review.js';
import { registerTreeRoutes } from './server-tree.js';
import { registerMoveRoutes } from './server-move.js';
import { registerTreeOpsRoutes } from './server-tree-ops.js';
import { registerFileRoutes } from './server-files.js';
import { registerEditorRoutes } from './server-editor.js';
import { registerCheckRoutes } from './server-check.js';
import { registerFileBaseRoutes } from './server-file-base.js';
import { registerCopyRoutes } from './server-copy.js';
import { registerSessionRoutes } from './server-sessions.js';
import { registerRetryRoute } from './server-retry.js';
import type { Activity, BaseOptions, Source, Task, Session, DeleteActivityScope, Config, Effect, Exec, HiveEvent, Language, Workspace, State } from './types.js';
import { dropCheckpoints } from './checkpoints.js';
import { dropBranches, dropStageStart, leftBehind } from './restart.js';
import { baseOptions, taskDir, checkBase, cleanWorktree, refuseUnmerged, removeWorktree } from './worktree.js';
import type { Logger } from './log.js';
import { type ConsoleStore, teardownRunId } from './console.js';
import type { PtyHost } from './pty-host.js';
import { removeInRun, type WorktreeRunDeps } from './task-setup.js';
import { removeTranscripts } from './transcript.js';
import type { EventLog } from './events.js';
import { sizeIn, type TerminalSize } from './terminal-wire.js';

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
export const MISSING_MESSAGE = 'tarefa sumiu do source: feche ou mantenha';
export const LEAVING_MESSAGE = 'tarefa saindo da source'; // #491: an archive, remove or delete of the source is in flight on it (#286)
const EPIC_MESSAGE = 'um épico não executa: sua etapa vem das filhas'; // #31: a show epic; the reducer's start ignores it
const DIFFERENT_STAGES_MESSAGE = 'tarefas em etapas diferentes';
const NOTHING_MISSING_MESSAGE = 'nenhuma tarefa dessa etapa saiu da source'; // #279: the stage's close all has nothing canCloseMissing allows
const DELETING_MESSAGE = 'atividade sendo excluída'; // a delete-activity stage or route is running git on it (#573)
const AUTO_BODY_MESSAGE = 'auto precisa ser true ou false';
const DROP_MESSAGE = 'drop precisa ser um objeto, com before em texto'; // #366: a drag's placement on move-to
const NOTHING_TO_DELETE_MESSAGE = 'nada para excluir'; // #236: no worktree, and no session the scope drops, outside a delete-activity stage
const SAME_STAGE_MESSAGE = 'tarefa já está nessa etapa';
const WORKSPACE_LOCKED_MESSAGE = 'delete the activity first'; // canSetWorkspace: the worktree, its branch and its sessions live in the old repo
const NEEDS_WORKSPACE: BaseOptions = { hasWorktree: false, defaultRef: '', tasks: [], local: [], remote: [], needsWorkspace: true };
// The 409 for each reason the delete activity button's tooltip names (#210): one lookup, so the route and the button cannot disagree.
const REMOVAL_MESSAGE: Record<RemovalBlocker, string> = {
  running: RUNNING_MESSAGE, deleting: DELETING_MESSAGE, nothingToDelete: NOTHING_TO_DELETE_MESSAGE,
};

export interface Refusal { status: number; message: string }

export interface TaskRouteDeps {
  exec: Exec; // git for the base popup (#131) and the delete-activity route (#182, #573); tests inject a fake
  log: Pick<Logger, 'debug' | 'error' | 'info'>; // the transcripts' deletion (#236): a file already gone at debug, a failure at error; the worktree setup's steps at info (#299)
  /** The live runtime comes with the state: agentArgs, the branch template, the base branch and the Comb's prefix are read at
   * call time, a POST /settings may have changed them; the source is the live one. */
  requireLive(res: Response): {
    state: State;
    runtime: { config: Pick<Config, 'agentArgs' | 'branch' | 'baseBranch' | 'comb' | 'editor'>; sources: ReadonlyMap<string, Pick<Source, 'comments' | 'create'>>; promptsDir: string; pluginDir: string };
  } | undefined;
  dispatch(event: HiveEvent, size?: TerminalSize): Promise<Effect[]>; // #808: size, the page's grid, reaches only the spawns this event causes
  language(): Language; // the Hive's effective language, the config's else the system's: a kept-both item's " - copy" suffix (#594)
  /** The pool's own started(ptyId) (#249): resolves once the run's pty exists (#251), rejects on a spawn failure or an unknown id.
   * What POST /tasks/:id/open and POST /activities/:id/sessions/:session/open await before answering the run they just started. */
  started(ptyId: string): Promise<void>;
  reviews: ReviewStore; // each task's review file (#591): the diff route drops its stale marks, the review routes read and write it
  notifyReview(taskId: string): void; // the named `review` event on /events after every write (#591)
  ptys: Pick<PtyHost, 'adopt' | 'subscribe'>; // a delete's teardown run (#654), and a first open's setup run (#351)
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  poll(names: string[], manual?: string[]): Promise<void>; // #846: the poll loop's one-source path, after a task is created on a source; manual: items born with auto off
  latest(): State | undefined; // #846: the state after that poll
  events?: Pick<EventLog, 'write'>; // #742: a delete's teardown steps and a first open's setup steps to worktree.step
}

export type LiveView = NonNullable<ReturnType<TaskRouteDeps['requireLive']>>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Why a manual start refuses a blocked task (#283). An open no longer does (#491): a blocker holds the stage run only. */
export const blockedMessage = (task: Task): string => `task bloqueado por ${(task.item.blockedBy ?? []).join(', ')}`;

/** Why a manual start would be a no-op in the reducer, as the answer the route gives; undefined when it can go through. No free worker is
 * not a refusal: the reducer opens one over the cap (#116). */
function startRefusal(state: State, itemId: string): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (task.item.epic !== undefined) return { status: HTTP_CONFLICT, message: EPIC_MESSAGE };
  const activity = activityOf(state, itemId);
  if (activity?.setup) return { status: HTTP_CONFLICT, message: SETUP_RUNNING_MESSAGE }; // before RUNNING: both paths answer the same (#351)
  if (activity?.workerId !== undefined || inAction(activity)) return { status: HTTP_CONFLICT, message: RUNNING_MESSAGE }; // #755, #834: a stage action runs
  if (task.missing) return { status: HTTP_CONFLICT, message: MISSING_MESSAGE };
  if (activity?.deleting || activity?.approval) return { status: HTTP_CONFLICT, message: activity?.deleting ? DELETING_MESSAGE : AWAITING_MESSAGE }; // the reducer ignores both (#268)
  const stage = stageOf(state.stages, task.stage);
  if (stage?.action !== undefined) return undefined; // a git command of the Hive or the workspace's commands (#755): no worker, no blockers, no prompt
  if (isBlocked(task.item)) return { status: HTTP_CONFLICT, message: blockedMessage(task) };
  if (stage?.prompt === undefined) return { status: HTTP_CONFLICT, message: 'etapa sem prompt' };
  return undefined;
}

/** The start the body asks for. `base: null` is the popup's default and drops a saved base. No string base, or a delete activity stage (which
 * never gets one): today's start. A base must be a branch git has and not the task's own (#131), else the answer is a 409 with the
 * reason and nothing starts. The body's workspace is checked like right-click › Workspace and saved with the start (#179). */
async function startEvent(deps: TaskRouteDeps, current: LiveView, itemId: string, body: unknown): Promise<Extract<HiveEvent, { type: 'start' }> | Refusal> {
  const { base, tellWorker, workspace: raw } = (body ?? {}) as { base?: unknown; tellWorker?: unknown; workspace?: unknown };
  const found = current.state.tasks.find((c) => c.item.itemId === itemId);
  if (!found) return { type: 'start', itemId };
  const task = placedTask(current.state, found, raw);
  if ('status' in task) return task;
  const workspace = workspaceOf(current.runtime.config, task, current.state.tasks); // #179: a task with no workspace is refused here, never a silent no-op
  if ('status' in workspace) return workspace;
  const placed = raw === undefined ? {} : { workspace: task.workspace };
  if (stageOf(current.state.stages, task.stage)?.action === 'deleteActivity') return { type: 'start', itemId, ...placed };
  if (base === null) return { type: 'start', itemId, base: null, ...placed }; // the popup's default: drops a saved base
  if (typeof base !== 'string') return { type: 'start', itemId, ...placed };
  try {
    await checkBase(workspace.path, base, branchFor(current.runtime.config, task.item), deps.exec, baseRemote(workspace));
  } catch (err) {
    return { status: HTTP_CONFLICT, message: errorMessage(err) };
  }
  return { type: 'start', itemId, base: { ref: base, tellWorker: tellWorker === true }, ...placed };
}

/** The user's answer to a task that left the source (fechar / manter): what the reducer would ignore in silence, as the route's answer. */
function taskRefusal(state: State, itemId: string): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (!task.missing) return { status: HTTP_CONFLICT, message: TASK_ON_SOURCE_MESSAGE };
  return activityOf(state, itemId)?.deleting ? { status: HTTP_CONFLICT, message: DELETING_MESSAGE } : undefined; // git is removing its worktree (#182)
}

/** Why a close would be a no-op in the reducer: a source task closes once it left the source, a local one (#132) once it stopped. */
function closeRefusal(state: State, itemId: string): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (activityOf(state, itemId)?.deleting) return { status: HTTP_CONFLICT, message: DELETING_MESSAGE }; // git is removing its worktree (#182)
  if (task.missing || canRemoveCreated(task, state)) return undefined;
  if (!task.created) return { status: HTTP_CONFLICT, message: TASK_ON_SOURCE_MESSAGE };
  return { status: HTTP_CONFLICT, message: RUNNING_MESSAGE }; // a run of any kind holds it (#164, #283); deleting was refused above
}

/** excluir task… (#542): a local task with a worktree loses it and its branch before it leaves the Hive, through the removal the
 * delete-activity route runs; both always go, as the glossary's delete activity says, the sessions and transcripts per the delete-activity scope.
 * deletingTask's mark holds the fill off while git runs, and taskDeleted drops the task in the reduction that drops the mark, so no fill in
 * between can hand it a worker: 'deleted', the close is done. deletingTask closes its terminals first (#573): git never runs under one.
 * A git refusal or failure is the 409 with git's words, and the task stays. Any other task has nothing to remove: undefined. */
async function removeCreatedWorktree(deps: TaskRouteDeps, current: LiveView, taskId: string): Promise<Refusal | 'deleted' | undefined> {
  const task = current.state.tasks.find((c) => c.item.itemId === taskId);
  const activity = activityOf(current.state, taskId);
  if (!task?.created || activity?.worktree === undefined || activity.local) return undefined;
  const workspace = workspaceOf(current.runtime.config, task, current.state.tasks);
  if ('status' in workspace) return workspace;
  const scope = current.state.deleteActivity; // the worktree and its branch always go (#573)
  await deps.dispatch({ type: 'deletingTask', taskId });
  try {
    await deleteActivityOnDisk({ workspace, activity, task, sessions: sessionsOf(current.state, task.item.itemId), branch: branchFor(current.runtime.config, task.item), scope }, deps);
  } catch (err) {
    await deps.dispatch({ type: 'activityKept', activityId: activity.id });
    return { status: HTTP_CONFLICT, message: errorMessage(err) };
  }
  await deps.dispatch({ type: 'taskDeleted', taskId });
  return 'deleted';
}

export const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

/** The task's workspace, or the route's answer when it has none (#179): 409 when the name it holds is gone, 400 when no rule answers one. */
export function workspaceOf(config: Pick<Config, 'comb'>, task: Task, tasks: readonly Task[] = []): Workspace | Refusal {
  return taskWorkspace(config, task, tasks) ?? { status: task.workspace === undefined ? HTTP_BAD_REQUEST : HTTP_CONFLICT, message: noWorkspaceReason(task) };
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
  if (task.missing) return { status: HTTP_CONFLICT, message: MISSING_MESSAGE };
  if (activity?.deleting) return { status: HTTP_CONFLICT, message: DELETING_MESSAGE }; // no terminal, session or worktree while git removes it (#182)
  if (activity?.setup) return { status: HTTP_CONFLICT, message: SETUP_RUNNING_MESSAGE }; // a second open, a run command or a session while it sets up (#351)
  if (!canOpenSession(task, activity)) return { status: HTTP_CONFLICT, message: LEAVING_MESSAGE }; // the checks above leave only leaving
  return activity ? { task, activity } : { task };
}

/** Why a move to `stage` would be a no-op in the reducer (#164, #366); the task and the stage already exist. A drop's `before` must be a
 * task of that stage: the drop line only ever shows between the target's tasks. */
function moveToRefusal(state: State, task: Task, stage: string, before?: string): Refusal | undefined {
  if (task.missing) return { status: HTTP_CONFLICT, message: MISSING_MESSAGE };
  if (!canMoveToStage(task, state)) return { status: HTTP_CONFLICT, message: RUNNING_MESSAGE }; // its stage run holds it, or it is leaving (#286)
  if (stage === task.stage) return { status: HTTP_CONFLICT, message: SAME_STAGE_MESSAGE };
  return before === undefined ? undefined : beforeRefusal(state, before, stage);
}

/** A drag's placement on move-to (#366). */
type Drop = NonNullable<Extract<HiveEvent, { type: 'moveToStage' }>['drop']>;

// The body's `drop`: undefined for right-click → move to, else an object whose `before`, when present, is a task id; `false` when malformed.
// Rebuilt from the checked fields, so nothing else in the body reaches the reducer.
function dropOf(raw: unknown): Drop | undefined | false {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const { before } = raw as { before?: unknown };
  if (before === undefined) return {};
  return typeof before === 'string' ? { before } : false;
}

/** Why the delete activity button would be a no-op in the reducer (removalBlocker, one message each), or the task. */
function removalRefusal(state: State, itemId: string): Refusal | Task {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  const blocker = removalBlocker(task, state);
  return blocker ? { status: HTTP_CONFLICT, message: REMOVAL_MESSAGE[blocker] } : task;
}

// A `before` that names no task (404) or a task outside `stage` (409): shared by the reorder and the move to (#366).
function beforeRefusal(state: State, before: string, stage: string): Refusal | undefined {
  const target = state.tasks.find((c) => c.item.itemId === before);
  if (!target) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  return target.stage === stage ? undefined : { status: HTTP_CONFLICT, message: DIFFERENT_STAGES_MESSAGE };
}

/** Why a move would be a no-op in the reducer: unknown task, unknown target, or a target in another stage (a reorder stays in its stage;
 * crossing stages is move-to's, #366). */
function moveRefusal(state: State, itemId: string, before: string | undefined): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  return before === undefined ? undefined : beforeRefusal(state, before, task.stage);
}

// The human override on a stopped task (start), the human answer to one that left the source (close / keep), the removal of a stopped task's worktree (delete-activity) and the Hive's own order
// (move / reset-order). The checks answer what the reducer would ignore in silence, so the UI is never left without an answer; a race between the check and the dispatch is a no-op in the
// reducer, never a spawn or a close it should not do.
export function registerTaskRoutes(app: Express, deps: TaskRouteDeps): void {
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
    if ('status' in event) {
      res.status(event.status).json({ error: event.message });
      return;
    }
    const discarded = await discardOrphan(deps, current, itemId, req.body); // #861: before the start, so its worktree is made from the base
    if (discarded) return void res.status(discarded.status).json({ error: discarded.error, code: discarded.code });
    const found = current.state.tasks.find((c) => c.item.itemId === itemId);
    await dispatch({ ...event, ...(found ? startLocal(req.body, activityOf(current.state, itemId)) : {}) }, sizeIn(req.body)); // the popup's switch (#444): the reducer writes it next to the base, a delete activity stage ignores it; #808: the page's grid
    res.json({ ok: true });
  });

  for (const action of ['close', 'keep'] as const) {
    app.post(`/tasks/:id/${action}`, async (req: Request, res: Response) => {
      const current = requireLive(res);
      if (!current) return;
      const taskId = req.params.id as string;
      const refusal = (action === 'close' ? closeRefusal : taskRefusal)(current.state, taskId);
      if (refusal) {
        res.status(refusal.status).json({ error: refusal.message });
        return;
      }
      const removal = action === 'close' ? await removeCreatedWorktree(deps, current, taskId) : undefined; // #542: git before the task goes
      if (typeof removal === 'object') return refuse(res, removal);
      if (removal === undefined) await dispatch(action === 'close' ? { type: 'closeTask', taskId } : { type: 'keepTask', taskId });
      res.json({ ok: true });
    });
  }

  registerCreateRoute(app, deps);
  registerCommentsRoute(app, deps);
  registerOrderRoutes(app, deps);
  registerCloseMissingRoute(app, deps);
  registerBaseRoute(app, deps);
  registerDeleteActivityRoute(app, deps);
  registerAutoRoutes(app, deps);
  registerRetryRoute(app, deps); // POST /tasks/:id/retry (#915)
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

// A stage's close all (#279): every stopped missing task of the stage in one reducer event, so no worker starts on one between this check
// and the close. The count is taken with the reducer's own rule; dispatch reduces before its first await, so it is what closes. No kill, no
// git: a running missing task keeps its own close / keep, and the worktrees stay on disk for Settings › Worktrees (#181, #182).
function registerCloseMissingRoute(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/stages/:name/close-missing', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const stage = req.params.name as string;
    if (stageOf(current.state.stages, stage) === undefined) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_STAGE_MESSAGE });
    const closed = current.state.tasks.filter((c) => c.stage === stage && canCloseMissing(c, current.state)).length;
    if (closed === 0) return refuse(res, { status: HTTP_CONFLICT, message: NOTHING_MISSING_MESSAGE });
    await dispatch({ type: 'closeMissing', stage });
    res.json({ closed });
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
function registerBaseRoute(app: Express, { exec, requireLive }: TaskRouteDeps): void {
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
      res.json(await baseOptions(workspace.path, activity?.slug ?? slugFor(task.item), others, workspaceBase(current.runtime.config, workspace), exec, orphanBranch));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) }); // git's own words: not a repo, a broken worktree list
    }
  });
}

/** What deleteActivityOnDisk needs (#654): git, the log, and what opens the teardown's console run. */
export type DeleteActivityDeps = WorktreeRunDeps & { log: Pick<Logger, 'debug' | 'error' | 'info'> };

/** What deleting a task's activity runs on disk (#236, #573, #654): git first, always the worktree and its branch, all or nothing as cleanWorktree
 * is, with the workspace's teardown between git's checks and the removal (a failing step refuses as git does), or the forced removeWorktree,
 * which runs no teardown; a Restart's left-behind branches and the stage-start ref (#283) after it. Then, once git is through, the transcripts
 * when the scope covers them. A refusal rejects before any transcript goes; a transcript that cannot be deleted is logged and the deletion
 * still counts as done. The teardown is a run of the setup channel labelled by the task. The stage's effect (server.ts), the ⋯ menu's item
 * and excluir task… (#542) share it. A local task (#444) runs no git and no teardown: its branch is usually the one the user's checkout
 * holds, which `branch -d` refuses. */
export async function deleteActivityOnDisk(
  // sessions: every record's of the task (#629), since a git job holds no state
  job: { workspace: Workspace; activity: Activity; task: Task; sessions: Session[]; branch: string; scope: DeleteActivityScope; force?: { promptsDir: string } }, deps: DeleteActivityDeps,
): Promise<void> {
  const { workspace, activity, task, sessions, branch, scope, force } = job;
  const { exec, log } = deps;
  const repo = workspace.path;
  if (!activity.local) {
    const extras = await leftBehind(repo, activity, branch, exec); // a Restart's old branches (#283)
    if (!force) for (const name of extras) await refuseUnmerged(repo, name, exec); // all or nothing, as cleanWorktree checks its own
    const target = { id: teardownRunId(task.item.itemId), label: `#${task.item.id}`, workspace, force: force !== undefined };
    await removeInRun(deps, target, (before) => (force ? removeWorktree(repo, activity, branch, force.promptsDir, exec) : cleanWorktree(repo, activity, branch, exec, before)));
    await dropBranches(repo, extras, force !== undefined, exec);
    await dropStageStart(repo, activity.slug ?? slugFor(task.item), exec); // #812: a stage entry clears stageStart, never the ref; a missing ref is nothing
    await dropCheckpoints(repo, activity.slug ?? slugFor(task.item), exec); // #619: every checkpoint's restore point goes with the activity; none is nothing
  }
  if (!scope.transcripts) return;
  await removeTranscripts(taskDir(repo, activity), repo, sessions, log) // a repo session in the main repo's dir too (#208)
    .catch((err: Error) => log.error(`transcripts #${task.item.id}: ${err.message}`));
}

// The ⋯ menu's delete activity (#182, #210, #573), also posted by the Settings worktree row and `clean up all orphans` (#181). The task is
// marked deleting before git, so no fill, manual start or delete-activity stage touches it while git runs; the answer drops the mark. Without
// force it is the delete-activity stage's git (no --force, branch -d), all or nothing: a refusal removes nothing and is an expected answer, 200
// with the reason, which the UI turns into the force popup. With a literal force: true it is the destructive removal; a failure there is a
// 500. Either failure leaves the task's fields: nothing was confirmed gone. A success forgets what the scope removed (#236); nothing to
// delete (a delete-activity stage only) runs no git and just moves the task on. In a delete-activity stage a success advances the task as the
// stage's own deletion would (the reducer's activityRemoved, so every caller gets it). The mark lands synchronously inside dispatch, right after
// the check, so the check and the mark cannot be split by another request.
function registerDeleteActivityRoute(app: Express, deps: TaskRouteDeps): void {
  const { requireLive, dispatch } = deps;
  app.post('/activities/:id/delete', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const target = taskTarget(current.state, activityParam(req)); // a live task activity (#629)
    if ('status' in target) return refuse(res, target);
    const { activity: live } = target;
    const task = removalRefusal(current.state, target.task.item.itemId);
    if ('status' in task) return refuse(res, task);
    if (live.local) return refuse(res, { status: HTTP_CONFLICT, message: LOCAL_MESSAGE }); // #444: no worktree to remove
    const scope = current.state.deleteActivity;
    // nothing to delete gets past removalRefusal only in a delete activity stage (#236): no git, no transcript, no workspace; the task just moves on
    const workspace = nothingToDelete(current.state, task, scope) ? undefined : workspaceOf(current.runtime.config, task, current.state.tasks); // the worktree's repo (#179)
    if (workspace && 'status' in workspace) return refuse(res, workspace);
    const force = (req.body as { force?: unknown } | undefined)?.force === true; // only a literal true forces
    const { config, promptsDir } = current.runtime;
    await dispatch({ type: 'deletingActivity', activityId: live.id });
    try {
      if (workspace) await deleteActivityOnDisk({ workspace, activity: live, task, sessions: sessionsOf(current.state, task.item.itemId), branch: branchFor(config, task.item), scope, ...(force ? { force: { promptsDir } } : {}) }, deps);
    } catch (err) {
      await dispatch({ type: 'activityKept', activityId: live.id });
      if (force) res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
      else res.json({ removed: false, refused: errorMessage(err) });
      return;
    }
    await dispatch({ type: 'activityRemoved', activityId: live.id });
    res.json({ removed: true });
  });
}

// A task created in the Comb (#132) or on a source (#846): from the stage header's `+`, or from any local process that speaks HTTP (a Claude
// session fed by another tool's MCP); like every dashboard POST it needs the x-hive-ui header. createTask picks the destination.
function registerCreateRoute(app: Express, { requireLive, dispatch, poll, latest }: TaskRouteDeps): void {
  app.post('/tasks', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const { config, sources } = current.runtime;
    const created = await createTask({ state: current.state, config, sources, dispatch, poll, latest }, req.body);
    if ('status' in created) return refuse(res, created);
    res.status(HTTP_CREATED).json(created); // itemId: what the new activity dialog starts it by
  });
}

// The auto switch (#164, #573): out of or back into the orchestrator's hands, and the move to another stage any task makes by hand
// (#366, #708). Neither touches git.
function registerAutoRoutes(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/tasks/:id/auto', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const auto = (req.body as { auto?: unknown } | undefined)?.auto;
    const task = current.state.tasks.find((c) => c.item.itemId === taskId);
    if (!task) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE });
    if (task.missing) return refuse(res, { status: HTTP_CONFLICT, message: MISSING_MESSAGE });
    if (typeof auto !== 'boolean') return refuse(res, { status: HTTP_BAD_REQUEST, message: AUTO_BODY_MESSAGE });
    await dispatch({ type: 'setAuto', taskId, auto });
    res.json({ ok: true });
  });

  app.post('/tasks/:id/move-to', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const { stage, drop: raw } = (req.body ?? {}) as { stage?: unknown; drop?: unknown };
    const task = current.state.tasks.find((c) => c.item.itemId === taskId);
    if (!task) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE });
    if (typeof stage !== 'string' || stageOf(current.state.stages, stage) === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: UNKNOWN_STAGE_MESSAGE });
    const drop = dropOf(raw);
    if (drop === false) return refuse(res, { status: HTTP_BAD_REQUEST, message: DROP_MESSAGE });
    const refusal = moveToRefusal(current.state, task, stage, drop?.before);
    if (refusal) return refuse(res, refusal);
    await dispatch({ type: 'moveToStage', taskId, stage, ...(drop ? { drop } : {}) });
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
