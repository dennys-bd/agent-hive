import type { Express, Request, Response } from 'express';
import { activityOf, isLocalActivityId, localWorkspaceOf, taskOfActivity } from './activities.js';
import { activityParam, keptTarget, liveTarget } from './activity-routes.js';
import { canRunCommand } from './task-runs.js';
import { continuable } from './tasks.js';
import { taskWorkspace, noWorkspaceReason, workspaceByName } from './config.js';
import { copyPending, continuableLocal } from './local-sessions.js';
import { commandsIn } from './run-commands.js';
import { answerOpen, type LiveView, type TaskRouteDeps, openTask, workspaceOf, type Refusal } from './server-tasks.js';
import { adoptTranscript, findTranscript } from './transcript.js';
import { sizeIn, type TerminalSize } from './terminal-wire.js';
import { transcriptDir } from './usage.js';
import { treeRoot } from './server-tree.js';
import { treeFolder } from './tree-paths.js';
import type { ActivityRecord, Task, Session, State } from './types.js';
import { workDir } from './worktree.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const UNKNOWN_TASK_MESSAGE = 'tarefa desconhecida';
const MISSING_MESSAGE = 'tarefa sumiu da source: feche ou mantenha';
const DELETING_MESSAGE = 'atividade sendo excluída';
const NOT_CONTINUABLE_MESSAGE = 'sessão já aberta ou desconhecida';
const NO_WORKTREE_MESSAGE = 'a worktree desta sessão não existe mais';
const NO_TRANSCRIPT_MESSAGE = 'O histórico desta sessão não existe mais';
const NO_RUN_WORKTREE_MESSAGE = 'tarefa sem worktree'; // #300: a task without one has no work to try
const UNKNOWN_COMMAND_MESSAGE = 'comando desconhecido';
const UNKNOWN_WORKSPACE_MESSAGE = 'workspace desconhecido'; // #292, #587
export const FOLDER_BODY_MESSAGE = 'folder must be a non-empty string'; // #818
export const COPY_PENDING_MESSAGE = 'uma cópia desta sessão ainda está abrindo'; // copyPending (#587)

type OpenDeps = Pick<TaskRouteDeps, 'requireLive' | 'dispatch' | 'started' | 'log'>;

const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

/** The session the sidebar asks to open (#208), or why openSession would ignore it, in the order the user would ask. A blocked task opens
 * (#491): a blocker holds the stage run only. */
function openable(state: State, record: ActivityRecord, id: string): { task: Task; session: Session } | Refusal {
  const task = taskOfActivity(state, record.id);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  const itemId = task.item.itemId;
  if (task.missing) return { status: HTTP_CONFLICT, message: MISSING_MESSAGE };
  const activity = activityOf(state, itemId);
  if (activity?.deleting) return { status: HTTP_CONFLICT, message: DELETING_MESSAGE }; // git is removing its worktree (#182)
  const session = continuable(task, state).find((s) => s.id === id && record.sessions.some((r) => r.id === id));
  if (!session) return { status: HTTP_CONFLICT, message: NOT_CONTINUABLE_MESSAGE };
  const noWorktree = activity?.worktree === undefined || activity.worktreeGone === true;
  return !session.repo && noWorktree ? { status: HTTP_CONFLICT, message: NO_WORKTREE_MESSAGE } : { task, session };
}

// A run command enabled in the task's workspace (#300, #511): a terminal running it in the task's worktree, answered like /open so the page attaches it at once.
// Unlike /open it never creates the worktree. The pool looks the name up again when it starts the run. A local activity has no task to try (#629).
function registerRunRoute(app: Express, deps: Pick<TaskRouteDeps, 'requireLive' | 'dispatch' | 'started'>): void {
  app.post('/activities/:id/run', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const target = liveTarget(current.state, activityParam(req));
    if ('status' in target) return refuse(res, target);
    if (!target.task) return refuse(res, { status: HTTP_CONFLICT, message: NO_RUN_WORKTREE_MESSAGE });
    const opened = openTask(current.state, target.task.item.itemId);
    if ('status' in opened) return refuse(res, opened);
    const { task, activity } = opened;
    if (!canRunCommand(task, activity)) return refuse(res, { status: HTTP_CONFLICT, message: NO_RUN_WORKTREE_MESSAGE });
    const workspace = workspaceOf(current.runtime.config, task);
    if ('status' in workspace) return refuse(res, workspace);
    const { command } = (req.body ?? {}) as { command?: unknown };
    // #755: the route serves the task menu, so a stages-only command is as unknown here as a name the Comb lacks
    if (typeof command !== 'string' || !commandsIn(current.runtime.config.comb.commands, workspace.name).some((c) => c.name === command)) return refuse(res, { status: HTTP_BAD_REQUEST, message: UNKNOWN_COMMAND_MESSAGE });
    await answerOpen(deps, await deps.dispatch({ type: 'openTerminal', activityId: target.activity.id, command }, sizeIn(req.body)), res);
  });
}

// The files tree's open in the integrated terminal (#818): a folder of the tree, relative, checked as a drop's folder is, as its real path;
// undefined without one, where every shell opened before
async function shellFolder(current: LiveView, id: string, raw: unknown): Promise<string | Refusal | undefined> {
  const { folder } = (raw ?? {}) as { folder?: unknown };
  if (folder === undefined) return undefined;
  if (typeof folder !== 'string' || folder === '') return { status: HTTP_BAD_REQUEST, message: FOLDER_BODY_MESSAGE };
  const root = treeRoot(current.state, current.runtime.config, id);
  return typeof root === 'string' ? treeFolder(root, folder) : root;
}

// A shell (#292, #629): on a local activity, in its workspace's main checkout, from the terminal panel's +; on a task's, a terminal in its worktree.
// With a folder (#818), in that folder of either. Answered like /open, so the page attaches the tab at once (#249). The reducer refuses
// what it cannot open in silence too.
function registerShellRoute(app: Express, deps: Pick<TaskRouteDeps, 'requireLive' | 'dispatch' | 'started'>): void {
  app.post('/activities/:id/shell', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const target = liveTarget(current.state, activityParam(req));
    if ('status' in target) return refuse(res, target);
    const { activity } = target;
    const cwd = await shellFolder(current, activity.id, req.body);
    if (typeof cwd === 'object') return refuse(res, cwd);
    if (activity.kind === 'local') {
      const local = workspaceByName(current.runtime.config, activity.workspace); // #696: its checkout is the terminal's start dir
      if (!local) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE_MESSAGE });
      return answerOpen(deps, await deps.dispatch({ type: 'openProjectShell', project: activity.workspace, cwd: cwd ?? local.path }, sizeIn(req.body)), res);
    }
    const opened = openTask(current.state, target.task?.item.itemId ?? '');
    if ('status' in opened) return refuse(res, opened);
    await answerOpen(deps, await deps.dispatch({ type: 'openTerminal', activityId: activity.id, ...(cwd === undefined ? {} : { cwd }) }, sizeIn(req.body)), res);
  });
}

// A new claude session in a workspace's local activity (#590). A task's activity opens its sessions through /open.
function registerNewLocalRoute(app: Express, deps: Pick<TaskRouteDeps, 'requireLive' | 'dispatch' | 'started'>): void {
  app.post('/activities/:id/sessions', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const target = liveTarget(current.state, activityParam(req));
    if ('status' in target) return refuse(res, target);
    const { activity } = target;
    if (activity.kind !== 'local') return refuse(res, { status: HTTP_CONFLICT, message: NOT_CONTINUABLE_MESSAGE });
    if (!workspaceByName(current.runtime.config, activity.workspace)) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE_MESSAGE });
    await answerOpen(deps, await deps.dispatch({ type: 'newLocalSession', activityId: activity.id }, sizeIn(req.body)), res);
  });
}

// A workspace's local session (#587), continued in its checkout with --resume. The reducer refuses in silence what continuableLocal does not
// offer, so the route says why first; the transcript sits in the checkout's own dir, never moved.
async function openLocal(deps: OpenDeps, current: LiveView, activityId: string, sessionId: string, size: TerminalSize | undefined, res: Response): Promise<void> {
  const name = localWorkspaceOf(activityId) ?? '';
  const found = workspaceByName(current.runtime.config, name);
  if (!found) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE_MESSAGE });
  if (!continuableLocal(current.state, name).some((s) => s.id === sessionId)) return refuse(res, { status: HTTP_CONFLICT, message: NOT_CONTINUABLE_MESSAGE });
  if (copyPending(current.state.workers, sessionId, transcriptDir(found.path))) return refuse(res, { status: HTTP_CONFLICT, message: COPY_PENDING_MESSAGE });
  if ((await findTranscript([found.path], sessionId)) === undefined) return refuse(res, { status: HTTP_CONFLICT, message: NO_TRANSCRIPT_MESSAGE });
  await answerOpen(deps, await deps.dispatch({ type: 'openLocalSession', activityId, sessionId }, size), res);
}

// A task's session from the details panel's list (#208), on any task: a free session (#283) resuming it, past the signal, the cap and the
// budget. A worktree session runs in the worktree; a `repo` one in the workspace's main repo, whose transcript dir gets it on its first open.
// The transcript is moved before the dispatch: claude --resume only looks in the dir of its cwd. `record` may be a deleted activity's (#629).
async function openTaskSession(deps: OpenDeps, current: LiveView, record: ActivityRecord, resume: string, size: TerminalSize | undefined, res: Response): Promise<void> {
  const checked = openable(current.state, record, resume);
  if ('status' in checked) return refuse(res, checked);
  const { task, session } = checked;
  const workspace = taskWorkspace(current.runtime.config, task); // workspaceOf's rule (#179)
  if (!workspace) return refuse(res, { status: task.workspace === undefined ? HTTP_BAD_REQUEST : HTTP_CONFLICT, message: noWorkspaceReason(task) });
  const dir = workDir(workspace.path, task, activityOf(current.state, task.item.itemId), record); // a kept session's transcript waits there until adopted (#208, #629)
  if (copyPending(current.state.workers, resume, transcriptDir(session.repo ? workspace.path : dir))) {
    return refuse(res, { status: HTTP_CONFLICT, message: COPY_PENDING_MESSAGE });
  }
  if (session.repo && !(await adoptTranscript(dir, workspace.path, resume))) {
    return refuse(res, { status: HTTP_CONFLICT, message: NO_TRANSCRIPT_MESSAGE }); // opening would start an empty conversation under that id
  }
  await answerOpen(deps, await deps.dispatch({ type: 'openSession', activityId: record.id, continueId: resume }, size), res);
}

/** A record's session opened again (#208, #587, #629): `:id` names any record, a deleted activity's too, a local one's in its checkout; a run
 * command (#300), a shell (#292) and a new local session (#590), each on a live activity. */
export function registerSessionRoutes(app: Express, deps: OpenDeps): void {
  app.post('/activities/:id/sessions/:session/open', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const kept = keptTarget(current.state, activityParam(req));
    if ('status' in kept) return refuse(res, kept);
    const sessionId = String(req.params.session);
    const size = sizeIn(req.body); // #808: the grid the resumed session's pty is born at
    if (isLocalActivityId(kept.record.id)) return openLocal(deps, current, kept.record.id, sessionId, size, res);
    await openTaskSession(deps, current, kept.record, sessionId, size, res);
  });
  registerRunRoute(app, deps); // POST /activities/:id/run (#300)
  registerShellRoute(app, deps); // POST /activities/:id/shell (#292)
  registerNewLocalRoute(app, deps); // POST /activities/:id/sessions (#590)
}
