import type { Express, Request, Response } from 'express';
import { activityOf, isLocalActivityId, localWorkspaceOf } from './activities.js';
import { activityParam, keptTarget, LOCAL_ACTIVITY_MESSAGE, taskTarget, UNKNOWN_ACTIVITY_MESSAGE } from './activity-routes.js';
import { taskBranch, liveRuns, startMode } from './task-runs.js';
import { branchFor, continuable } from './tasks.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { continuableLocal } from './local-sessions.js';
import { discarded, type RestartPlan, restartPlan, restartWorktree } from './restart.js';
import { AWAITING_MESSAGE } from './server-approval.js';
import { recordCheckpoint } from './server-checkpoints.js';
import { type TaskRouteDeps, type LiveView, workspaceOf, type Refusal, refuse, RUNNING_MESSAGE, SETUP_RUNNING_MESSAGE, UNKNOWN_TASK_MESSAGE } from './server-tasks.js';
import { removeTranscripts } from './transcript.js';
import type { Activity, ActivityRecord, Task, State, Worker } from './types.js';
import { liveShell } from './terminal-runs.js';
import { sizeIn } from './terminal-wire.js';
import { workDir } from './worktree.js';

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const SLEEP_BODY_MESSAGE = 'informe ptyIds: os ids das execuções a dormir'; // #672
const SLEEP_SPLIT_MESSAGE = 'as execuções são de atividades diferentes'; // #672: a sleep all is one activity's
const NO_RUN_MESSAGE = 'nenhuma execução viva com esse id';
const NO_WAIT_MESSAGE = 'nenhuma espera de CI nessa atividade'; // #834
const HTTP_CONFLICT = 409;
const NO_CONTINUE_MESSAGE = 'nada para continuar';
const SESSION_HELD_MESSAGE = 'sessão já aberta'; // a live run holds the stage's session: the UI focuses it instead (#283)
const NO_RESTART_MESSAGE = 'reinício indisponível para essa etapa';
const RUNS_OPEN_MESSAGE = 'feche as sessões abertas da tarefa antes de reiniciar'; // git never resets a worktree a session or a terminal is in (#283)
export const SESSION_UNAVAILABLE_MESSAGE = 'Esta sessão está em uso ou não existe mais'; // a session continuable does not offer (#304)

// A live agent run (#672): a worker's, never a terminal's, which has no session to sleep
const agentRun = (state: State, id: string): Worker | undefined => state.workers.find((w) => w.runId === id && w.status !== 'empty');

// A commands stage's running command (#755), by the activity it runs in: a Stop and a sleep all reach it as they reach a terminal
const stageRun = (state: State, id: string): string | undefined => state.activities.find((a) => a.commands?.ptyId === id)?.id;

// What a sleep all may list (#672, #696, #755): a live agent run, a live plain terminal or a running stage command, by the activity it belongs
// to; undefined for anything else
function sleepableIn(state: State, id: string): string | undefined {
  const run = agentRun(state, id);
  return run === undefined ? liveShell(state, id)?.activityId ?? stageRun(state, id) : run.activityId ?? '';
}

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string');

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A pty the state still holds (#283, #570): a live worker's run, stage or not, a live terminal, or a commands stage's command (#755); a
// sleeping terminal has no pty (#696)
const isLive = (state: State, id: string): boolean =>
  state.workers.some((w) => w.runId === id && w.status !== 'empty') || state.terminals.some((t) => t.terminalId === id && t.asleep === undefined) || stageRun(state, id) !== undefined;

/** The routes of one flow to start and stop a task (#283): a run's Stop, the crash popup's close, Continue, Restart and clearing one of a
 * task's sessions (#304). The checks answer what the reducer would ignore in silence, so the UI is never left without an answer. */
export function registerRunRoutes(app: Express, deps: TaskRouteDeps): void {
  registerPtyRoutes(app, deps);
  registerCiStopRoute(app, deps);
  registerSleepRoutes(app, deps);
  registerContinueRoute(app, deps);
  registerRestartRoutes(app, deps);
  registerClearRoute(app, deps);
}

// The routes of one pty, by its id (#283, #570): Stop, the only way a user ends a run or a terminal; and the crash popup's close. The pty
// itself is reached over its WebSocket (server-pty-socket.ts, #407), not a route here.
function registerPtyRoutes(app: Express, deps: TaskRouteDeps): void {
  const { requireLive, dispatch } = deps;
  app.post('/ptys/:id/stop', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const id = req.params.id as string;
    if (!isLive(current.state, id)) return void res.status(HTTP_NOT_FOUND).json({ error: NO_RUN_MESSAGE });
    await dispatch({ type: 'stop', ptyId: id, cause: 'manual' }); // #672: the only cause a single stop carries; a terminal ignores it
    res.json({ ok: true });
  });
  app.post('/crash/dismiss', async (_req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await dispatch({ type: 'dismissCrash' });
    res.json({ ok: true });
  });
}

// Sleep all and the forget of a sleeping tab (#672): every listed agent run, all of one activity, stops with cause all, checked whole before
// any stop; a live terminal of the activity sleeps with them (#696), through the stop that reads its cwd. A closed sleeping tab's transcript
// goes with it, its record or not (its run may not have exited yet)
function registerSleepRoutes(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/ptys/sleep', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const listed: unknown = (req.body as { ptyIds?: unknown } | undefined)?.ptyIds;
    if (!isIdList(listed)) return void res.status(HTTP_BAD_REQUEST).json({ error: SLEEP_BODY_MESSAGE });
    const ptyIds = [...new Set(listed)]; // a repeated id would send its run a second kill
    const unknown = ptyIds.find((id) => sleepableIn(current.state, id) === undefined);
    if (unknown !== undefined) return void res.status(HTTP_NOT_FOUND).json({ error: `${NO_RUN_MESSAGE}: ${unknown}` });
    if (new Set(ptyIds.map((id) => sleepableIn(current.state, id))).size > 1) return void res.status(HTTP_BAD_REQUEST).json({ error: SLEEP_SPLIT_MESSAGE });
    for (const ptyId of ptyIds) await dispatch({ type: 'stop', ptyId, cause: 'all' });
    res.json({ ok: true });
  });
  app.delete('/ptys/:id/scrollback', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await dispatch({ type: 'forgetSlept', ptyId: req.params.id as string });
    res.json({ ok: true });
  });
}

// Continue (#283): only while startMode offers it, and never while a live run holds the stage's session (the UI focuses that run instead); the
// reducer resumes the stage's latest session.
function registerContinueRoute(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/activities/:id/continue', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const activityId = activityParam(req);
    const target = keptTarget(current.state, activityId); // a deleted activity's record too: its session resumes in a new activity (#629)
    if ('status' in target) return refuse(res, target);
    const { task } = target;
    if (!task) return refuse(res, isLocalActivityId(activityId) ? { status: HTTP_CONFLICT, message: LOCAL_ACTIVITY_MESSAGE } : { status: HTTP_NOT_FOUND, message: UNKNOWN_ACTIVITY_MESSAGE });
    if (activityOf(current.state, task.item.itemId)?.setup) return refuse(res, { status: HTTP_CONFLICT, message: SETUP_RUNNING_MESSAGE }); // the worktree setup runs (#351)
    const mode = startMode(task, current.state);
    if (mode === 'running') return refuse(res, { status: HTTP_CONFLICT, message: RUNNING_MESSAGE });
    if (mode === 'approval') return refuse(res, { status: HTTP_CONFLICT, message: AWAITING_MESSAGE }); // #268
    if (typeof mode !== 'object' || !mode.continue) return refuse(res, { status: HTTP_CONFLICT, message: NO_CONTINUE_MESSAGE }); // #812: not after a free run
    if (mode.live !== undefined) return refuse(res, { status: HTTP_CONFLICT, message: SESSION_HELD_MESSAGE });
    await dispatch({ type: 'continue', activityId }, sizeIn(req.body)); // #808: the page's grid
    res.json({ ok: true });
  });
}

// The task a Restart acts on, its repo and worktree, the branch it is on and the stage's starting commit (#283), or why not.
interface RestartTarget { task: Task; activity: Activity; repo: string; worktree: string; branch: string; template: string; commit: string }

function restartTarget(current: LiveView, activityId: string): RestartTarget | Refusal {
  const target = taskTarget(current.state, activityId);
  if ('status' in target) return target;
  const { task, activity } = target;
  if (activity.setup) return { status: HTTP_CONFLICT, message: SETUP_RUNNING_MESSAGE }; // #351
  const mode = startMode(task, current.state);
  if (mode === 'approval') return { status: HTTP_CONFLICT, message: AWAITING_MESSAGE }; // #268
  if (typeof mode !== 'object' || !mode.restart || activity.stageStart === undefined) return { status: HTTP_CONFLICT, message: NO_RESTART_MESSAGE };
  if (mode.live !== undefined || liveRuns(task, current.state).length > 0) return { status: HTTP_CONFLICT, message: RUNS_OPEN_MESSAGE };
  const workspace = workspaceOf(current.runtime.config, task);
  if ('status' in workspace) return workspace;
  const template = branchFor(current.runtime.config, task.item);
  return { task, activity, repo: workspace.path, worktree: workDir(workspace.path, task, activity), branch: taskBranch(activity, template), template, commit: activity.stageStart.commit };
}

// Restart (#283): GET is the confirmation's preview; POST marks the task, runs the git, then dispatches. The server runs the git, never the
// worker; a failure is git's words as a 409, the mark goes and the task is left as it was. A restart the reducer ignores is a 409 too.
function registerRestartRoutes(app: Express, deps: TaskRouteDeps): void {
  const { requireLive, dispatch, exec } = deps;
  app.get('/activities/:id/restart', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const target = restartTarget(current, activityParam(req));
    if ('status' in target) return refuse(res, target);
    try {
      const plan = await restartPlan(target.repo, target.branch, target.template, target.commit, exec);
      res.json({ ...plan, branch: target.branch, ...(await discarded(target.worktree, target.branch, target.commit, plan, exec)) });
    } catch (err) {
      refuse(res, { status: HTTP_CONFLICT, message: errorMessage(err) });
    }
  });
  app.post('/activities/:id/restart', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const activityId = activityParam(req);
    const target = restartTarget(current, activityId);
    if ('status' in target) return refuse(res, target);
    await dispatch({ type: 'restarting', activityId }); // marked before any git: nothing else may start on the worktree meanwhile
    const marked = requireLive(res)?.state;
    if (!marked?.activities.find((a) => a.id === activityId)?.deleting) return refuse(res, { status: HTTP_CONFLICT, message: NO_RESTART_MESSAGE });
    // #619: the checkpoint this Restart throws away, kept before any of its git; a failed capture only costs that restore point
    await recordCheckpoint(deps, { repo: target.repo, activity: target.activity, task: target.task, stage: target.task.stage, ended: 'restart' });
    let plan: RestartPlan;
    try {
      plan = await restartPlan(target.repo, target.branch, target.template, target.commit, exec);
      await restartWorktree(target.worktree, target.branch, target.commit, plan, exec);
    } catch (err) {
      await dispatch({ type: 'activityKept', activityId }); // only the mark goes
      return refuse(res, { status: HTTP_CONFLICT, message: errorMessage(err) });
    }
    const effects = await dispatch({ type: 'restart', activityId, ...(plan.mode === 'branch' ? { branch: plan.newBranch } : {}) }, sizeIn(req.body));
    if (!effects.some((e) => e.type === 'spawn')) {
      const after = requireLive(res);
      const reason = after?.state.activities.find((a) => a.id === activityId)?.error; // a slug refusal, or nothing
      return refuse(res, { status: HTTP_CONFLICT, message: reason ?? NO_RESTART_MESSAGE });
    }
    res.json({ ok: true });
  });
}

// A session's limpar (#304): only a session continuable offers, the reducer's own rule, so the transcript deleted is the session it forgets (a
// repo one in the main repo's dir too, #208); it goes only when the deleteActivity scope says so. A deletion that fails is logged: the session is
// already forgotten. `:id` names a record (#629), a deleted activity's too; a local one's is a workspace's local session (#587), whose transcript
// sits in the checkout's own dir.
function registerClearRoute(app: Express, deps: TaskRouteDeps): void {
  app.post('/activities/:id/sessions/:session/clear', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const kept = keptTarget(current.state, activityParam(req));
    if ('status' in kept) return refuse(res, kept);
    const sessionId = String(req.params.session);
    if (isLocalActivityId(kept.record.id)) return clearLocal(deps, current, kept.record.id, sessionId, res);
    if (!kept.task) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE });
    await clearTaskSession(deps, current, kept.task, kept.record, sessionId, res);
  });
}

async function clearTaskSession({ dispatch, log }: TaskRouteDeps, current: LiveView, task: Task, record: ActivityRecord, sessionId: string, res: Response): Promise<void> {
  const taskId = task.item.itemId;
  const session = continuable(task, current.state).find((s) => s.id === sessionId);
  if (!session || !record.sessions.some((s) => s.id === sessionId)) return refuse(res, { status: HTTP_CONFLICT, message: SESSION_UNAVAILABLE_MESSAGE });
  const workspace = current.state.deleteActivity.transcripts ? taskWorkspace(current.runtime.config, task) : undefined;
  // read before the clear, which takes the session off its record
  const dir = workspace && workDir(workspace.path, task, activityOf(current.state, taskId), record);
  await dispatch({ type: 'clearSessions', activityId: record.id, sessionId: session.id });
  if (workspace && dir) {
    await removeTranscripts(dir, workspace.path, [session], log).catch((err: Error) => log.error(`transcripts #${task.item.id}: ${err.message}`));
  }
  res.json({ ok: true });
}

async function clearLocal({ dispatch, log }: TaskRouteDeps, current: LiveView, activityId: string, sessionId: string, res: Response): Promise<void> {
  const name = localWorkspaceOf(activityId) ?? '';
  const found = workspaceByName(current.runtime.config, name);
  if (!found) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_ACTIVITY_MESSAGE });
  const session = continuableLocal(current.state, name).find((s) => s.id === sessionId);
  if (!session) return refuse(res, { status: HTTP_CONFLICT, message: SESSION_UNAVAILABLE_MESSAGE });
  await dispatch({ type: 'clearLocalSession', activityId, sessionId });
  if (current.state.deleteActivity.transcripts) { // A11: the deleteActivity scope decides, as a task's limpar
    await removeTranscripts(found.path, found.path, [session], log).catch((err: Error) => log.error(`transcripts local ${name}: ${err.message}`));
  }
  res.json({ ok: true });
}

// The Stop of a wait for CI (#834): the wait holds no pty, so /ptys/:id/stop cannot reach it; the task's dormir, the bar's and dormir todas post
// here. The wait ends, the activity stopped, with no verdict. An activity waiting for nothing: 404, as an unknown run is.
function registerCiStopRoute(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/activities/:id/ci/stop', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const activityId = activityParam(req);
    if (current.state.activities.find((a) => a.id === activityId)?.ci === undefined) return void res.status(HTTP_NOT_FOUND).json({ error: NO_WAIT_MESSAGE });
    await dispatch({ type: 'stopCi', activityId });
    res.json({ ok: true });
  });
}
