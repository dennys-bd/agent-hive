import { AGENTS, ranAgent } from './agents.js';
import { activityOf, keptTerminalsIn, localActivityId } from './activities.js';
import { withLaunch } from './launch-pick.js';
import { localSessionsOf } from './local-sessions.js';
import { canOpenSession, inAction, taskId, stageOf, isBlocked, isGate, onSource, resolveWorkspace, sessionsOf, terminalsOf, workersOf } from './tasks.js';
import { hiveAction, runsAgent } from './stage-agent.js';
import type { Activity, AgentId, LaunchPick, RunPick, Task, TaskBase, Session, DiffScope, SessionPolicy, Terminal, Worker, SpawnRun, State } from './types.js';

/** What a task offers (#283), the one place the UI and the routes read it: nothing, its running stage, Start, or an object: Continue when
 * `continue` is true, Restart when `restart` is; with `continue: false` the UI offers Start beside Restart (#812). `live` names the run that
 * already holds the stage's session: Continue focuses it instead of starting a second process. Approval while the task awaits the user (#268);
 * a held one still reads running, so its live session is reachable. */
export type StartMode = 'none' | 'running' | 'start' | 'approval' | { continue: boolean; restart: boolean; live?: string };

/** What a live run on a task is (#251): its stage run, one of the user's sessions or a terminal. The terminal panel names a tab by it. */
export type RunKind = 'stage' | 'session' | 'terminal';

/** The session that ran `stage` last (#283), oldest first as the list is: undefined when the stage has not run on this task. */
export function stageSession(task: Task, state: Pick<State, 'activityRecords'>, stage: string): Session | undefined {
  return sessionsOf(state, taskId(task)).filter((s) => s.stages.includes(stage)).at(-1);
}

/** The session a manual gate takes feedback in (HIVE-2, #685): the latest one of the stage right before the gate, the work the gate reviews;
 * without one (a first-stage gate, a task moved or polled straight into the gate) the task's latest session of any stage. Undefined outside a
 * gate and on a task with no session, whose feedback starts a new one. */
export function gateSession(task: Task, state: Pick<State, 'stages' | 'activityRecords'>): Session | undefined {
  const at = state.stages.findIndex((s) => s.name === task.stage);
  if (at < 0 || !isGate(state.stages[at])) return undefined;
  const reviewed = at > 0 ? stageSession(task, state, state.stages[at - 1].name) : undefined;
  return reviewed ?? sessionsOf(state, taskId(task)).at(-1);
}

// The free session whose hive_done ended the stage (#812), which the approval names while the task awaits: it did the work. Gone once cleared
function approvalSession(task: Task, state: Pick<State, 'activities' | 'activityRecords'>): Session | undefined {
  const id = activityOf(state, taskId(task))?.approval?.sessionId;
  return id === undefined ? undefined : sessionsOf(state, taskId(task)).find((s) => s.id === id);
}

/** The session feedback resumes (#268, HIVE-2, #685): the free session that ended the stage when the approval names one (#812); in a manual gate
 * gateSession's, otherwise the stage's own latest. `stage` defaults to the task's: a spawn names the stage it runs. */
export function feedbackSession(task: Task, state: Pick<State, 'stages' | 'activities' | 'activityRecords'>, stage = task.stage): Session | undefined {
  return approvalSession(task, state) ?? (isGate(stageOf(state.stages, stage)) ? gateSession(task, state) : stageSession(task, state, stage));
}

/** The user's own session open on the conversation feedback would resume (#483): a live free session on the task whose session is
 * feedbackSession's. Feedback is typed there instead of spawning a second process on that session. The reducer and the UI share it. */
export function openFeedbackSession(task: Task, state: Pick<State, 'stages' | 'workers' | 'activities' | 'activityRecords'>): (Worker & { runId: string }) | undefined {
  const session = feedbackSession(task, state);
  if (!session) return undefined;
  return state.workers.find((s): s is Worker & { runId: string } =>
    s.freeSession === true && s.status !== 'empty' && s.activityId === activityOf(state, taskId(task))?.id && s.runId !== undefined && s.sessionId === session.id);
}

/** How a spawn answers a handover (#134, was #268's queued feedback): the session it names resumed as a continue run, or a new session; its
 * prompt replaces the run's own. The handover leaves the activity with the spawn (#629). Undefined without one. */
export function handoverRun(activity: Activity): { activity: Activity; run: SpawnRun; policy: SessionPolicy; prompt: string } | undefined {
  if (activity.handover === undefined) return undefined;
  const { handover, ...rest } = activity;
  return handover.sessionId === undefined
    ? { activity: rest, run: 'stage', policy: 'new', prompt: handover.prompt }
    : { activity: { ...rest, sessionId: handover.sessionId }, run: 'continue', policy: 'continue', prompt: handover.prompt };
}

/** A manual start's picks on the activity (#290), for the occupy of the same reduction: none asked, or a handover that already decides the
 * session and the prompt (#134), writes nothing. */
export const withRunPick = (activity: Activity, runPick: RunPick | undefined): Activity =>
  (runPick === undefined || activity.handover !== undefined ? activity : { ...activity, runPick });

/** The picks a stage run spawns with (#290), taken off the activity: the session they ask for (a new one, or `resume`'s, which becomes the
 * activity's sessionId), or no policy when they leave it to the stage. */
export function pickedRun(activity: Activity): { activity: Activity; pick?: RunPick; policy?: SessionPolicy } {
  const { runPick, ...rest } = activity;
  if (runPick === undefined) return { activity: rest };
  if (runPick.resume === undefined) return { activity: rest, pick: runPick };
  return runPick.resume === null
    ? { activity: rest, pick: runPick, policy: 'new' }
    : { activity: { ...rest, sessionId: runPick.resume }, pick: runPick, policy: 'continue' };
}

/** Whether executar etapas posts a start (#290): Start, or Start beside Restart after a free run (#812); a Continue resumes the stage's session
 * instead. What offers personalizar and what the start route admits picks on. */
export const startsFresh = (mode: StartMode): boolean => mode === 'start' || (typeof mode === 'object' && !mode.continue);

/**
 * What the task offers (#283). None for a blocked, missing, deleting or leaving (#286) task and a stage with nothing to run (no prompt, no skill (#710), no deleteActivity action; a
 * delete activity stage ignores blockers, as its start does). Running while a stage worker holds it. Start while its stage has not run, in any stage
 * and on a non-auto task too, except a continue stage on a task with no session at all (#350): none. Otherwise Continue, and Restart only on a stage that starts a new session and whose start was recorded: restarting
 * a stage that continues the previous stage's session would throw that context away. A live worker of the task on the stage's session (only a
 * session can be one here: a stage worker makes the mode `running`) is named as `live`. After a free run in the task's stage (#812), Start and
 * Restart (`continue: false`) or Start alone, never Continue, unless a live run holds the stage's session.
 */
export function startMode(task: Task, state: Pick<State, 'stages' | 'workers' | 'activities' | 'activityRecords'>): StartMode {
  const stage = stageOf(state.stages, task.stage);
  const activity = activityOf(state, taskId(task));
  if (!stage || task.missing || activity?.deleting || task.leaving || task.item.epic !== undefined) return 'none'; // #31: a show epic never runs
  if (hiveAction(stage) === undefined && (!runsAgent(stage) || isBlocked(task.item))) return 'none';
  if (activity?.workerId !== undefined || inAction(activity)) return 'running'; // #755, #834: a commands stage or a wait for CI in flight runs too
  if (activity?.setup) return 'none'; // a first open's worktree setup runs (#351): nothing to start, continue or restart until it ends
  if (activity?.approval) return 'approval'; // the stage waits for the user's approve or feedback (#268): nothing to start, continue or restart
  const session = hiveAction(stage) === undefined ? stageSession(task, state, task.stage) : undefined;
  const holder = session && workersOf(state, task).find((s) => s.sessionId === session.id);
  const restart = !activity?.local && stage.session !== 'continue' && activity?.stageStart?.stage === task.stage; // #444: never a reset of the user's checkout
  // #812: after a free run in this stage there is nothing of a stage run's to go on with, and continue would send the stage's continue prompt:
  // start, plus restart to undo what the free run did. Not while a live run (the user's hand resume) holds the stage's session: continue then
  // only focuses it, and a start would put a second process on the session
  if (hiveAction(stage) === undefined && activity?.freeSessionStage === task.stage && holder?.runId === undefined) return restart ? { continue: false, restart } : 'start';
  // A continue stage with no session at all has nothing to resume, and a new run would miss the context it expects: a manual session only (#350)
  if (session === undefined) return hiveAction(stage) === undefined && stage.session === 'continue' && sessionsOf(state, taskId(task)).length === 0 ? 'none' : 'start';
  return { continue: true, restart, ...(holder?.runId ? { live: holder.runId } : {}) };
}

/** Whether a run command may start on the task (#300): open to a session (canOpenSession) with its worktree on disk (#208). The route, the
 * menu and the panel read this one rule; the reducer's terminal rule (openTerminal) is the same. */
export const canRunCommand = (task: Task, activity: Activity | undefined): boolean =>
  canOpenSession(task, activity) && activity?.worktree !== undefined && !activity.worktreeGone;

/** Whether the task has a diff of `scope` to show (#270): a worktree on disk (#208), and for the stage a start recorded in its current stage
 * (#283). The worktree and commit scopes (#591) need only the worktree; the checkpoint scope needs a checkpoint (#619). The menu, the pane and the route read this one rule. */
export const canDiff = (task: Task, activity: Activity | undefined, scope: DiffScope): boolean =>
  activity?.worktree !== undefined && !activity.worktreeGone && (scope !== 'stage' || activity.stageStart?.stage === task.stage)
  && (scope !== 'checkpoint' || (activity.checkpoints?.length ?? 0) > 0); // #619

/** Whether a checkpoint can be captured on the activity (#619): its worktree on disk, as canDiff reads it, never the user's own checkout (#444). */
export const capturable = (activity: Activity | undefined): activity is Activity =>
  activity !== undefined && activity.worktree !== undefined && !activity.worktreeGone && !activity.local;

/** The run commands the task offers (#300): its workspace's command names as the config last set them; [] when it resolves to none. */
export const commandsOf = (task: Task, state: Pick<State, 'workspaces' | 'sourceWorkspaces' | 'commands' | 'tasks'>): string[] =>
  onSource(state.commands, resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks)) ?? [];

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The activity's branch when it is one the Hive made for the task (#283, #629): the template's own branch, or a `<template>-r<n>` a Restart
 * created. A hook reports the branch, so anything else is not trusted. */
export function ownBranch(activity: Pick<Activity, 'branch'>, template: string): string | undefined {
  const { branch } = activity;
  return branch !== undefined && new RegExp(`^${escaped(template)}(-r\\d+)?$`).test(branch) ? branch : undefined;
}

/** The branch the task's worktree is on (#283): the one a Restart moved it to, else the template's (and with no activity, the template's). */
export const taskBranch = (activity: Pick<Activity, 'branch'> | undefined, template: string): string =>
  (activity === undefined ? undefined : ownBranch(activity, template)) ?? template;

const RUN_LABEL = 8; // characters of a session id a run's name shows while its session has no name (#283)
const TERMINAL = 'Terminal';

/** One live run on a task (#283): what the pickers list and the terminal panel and an activity open (#251, #457): its label, what runs in
 * it (#489: its agent · the session's name or id, the agent alone before the id is known, Terminal or Terminal <n> for a plain terminal, a run command's name, #300),
 * and its kind. */
export interface LiveRun { ptyId: string; label: string; kind: RunKind; session?: string; terminalId?: string; agent?: AgentId; launch?: LaunchPick } // agent: what an agent run runs (#925), absent on a terminal; session: a worker run's name or short id, once known; terminalId: a captured session's run lives in this terminal's pty (#696); launch: a free run's picks, which its pane header names (#257)

/** A session as a run names it (#489, #590): its /rename title, else the head of its id. */
export const sessionLabel = ({ id, name }: Pick<Session, 'id' | 'name'>): string => name ?? id.slice(0, RUN_LABEL);

// A run of session `id` (#489): its agent's label · its name or short id once known, the label alone before (#925: the run's own agent); the
// UI names a sleeping run the same way (#672)
export function namedRun(ptyId: string, id: string | undefined, sessions: Session[], kind: RunKind, agent: AgentId): LiveRun {
  const name = id === undefined ? undefined : sessionLabel(sessions.find((s) => s.id === id) ?? { id });
  const who = AGENTS[agent].label;
  const run: LiveRun = { ptyId, label: name === undefined ? who : `${who} · ${name}`, kind, agent };
  return name === undefined ? run : { ...run, session: name };
}

// What a run takes from its worker: a captured session's run (#696) names the terminal it lives in, what its line opens; a free run opened
// with picks carries them, for its pane header (#257)
const fromWorker = (run: LiveRun, worker: Worker): LiveRun => ({
  ...run, ...(worker.terminalId === undefined ? {} : { terminalId: worker.terminalId }), ...withLaunch(worker.launch),
});

// A worker's run: the stage run learns its session id late (the activity's sessionId has it from the spawn). A /rename names it once a turn
// end read it (#489).
function workerRun(activity: Activity | undefined, worker: Worker, sessions: Session[]): LiveRun[] {
  if (!worker.runId) return [];
  const id = worker.sessionId ?? (worker.freeSession ? undefined : activity?.sessionId);
  return [fromWorker(namedRun(worker.runId, id, sessions, worker.freeSession ? 'session' : 'stage', ranAgent(worker)), worker)];
}

/** A terminal's name (#489): a run command's own (#300); a plain one is Terminal, numbered in the order they opened once its activity keeps
 * several, sleeping ones included (#696), so a terminal keeps its number while another sleeps. Derived, not stored: a forgotten one renumbers
 * the rest. */
export function terminalLabel(terminal: Terminal, plain: Terminal[]): string {
  if (terminal.command !== undefined) return terminal.command;
  return plain.length > 1 ? `${TERMINAL} ${plain.findIndex((t) => t.terminalId === terminal.terminalId) + 1}` : TERMINAL;
}

// #347: a plain terminal running a live captured session reads as that session's run, whatever activity holds the session (a session id is
// in one record only, so every record is looked in); Terminal N again once the run ends
function terminalRun(state: Pick<State, 'workers' | 'activityRecords'>, terminal: Terminal, plain: Terminal[]): LiveRun {
  const worker = state.workers.find((w) => w.terminalId === terminal.terminalId && w.status !== 'empty');
  const runId = worker?.runId;
  const label = worker === undefined || runId === undefined
    ? terminalLabel(terminal, plain)
    : namedRun(runId, worker.sessionId, state.activityRecords.flatMap((r) => r.sessions), 'session', ranAgent(worker)).label;
  return { ptyId: terminal.terminalId, label, kind: 'terminal' };
}

/** Every live run on the task (#283): its workers (the stage run and each session), then its terminals. `commands: false` leaves out the
 * command terminals (#353): the generic Stop and the Terminal picker never list them, their own item stops them. Restart and the delete activity's
 * blocker still count them. */
export function liveRuns(task: Task, state: Pick<State, 'workers' | 'terminals' | 'activities' | 'activityRecords'>, { commands = true }: { commands?: boolean } = {}): LiveRun[] {
  const own = terminalsOf(state, task);
  const activity = activityOf(state, taskId(task));
  const plain = activity === undefined ? [] : keptTerminalsIn(state.terminals, activity.id); // #696: numbered among the kept ones
  const terminals = own
    .filter((t) => commands || t.command === undefined)
    .map((t) => terminalRun(state, t, plain));
  const sessions = sessionsOf(state, taskId(task));
  return [...workersOf(state, task).flatMap((w) => workerRun(activity, w, sessions)), ...terminals];
}

/** Every live run of a workspace's local activity (#590), as liveRuns lists a task's: its claude sessions, named by the kept session they run,
 * then its terminals. */
export function localRuns(workspace: string, state: Pick<State, 'workers' | 'terminals' | 'activityRecords'>): LiveRun[] {
  const kept = localSessionsOf(state, workspace);
  const sessions = state.workers.flatMap((w) => (w.status !== 'empty' && w.activityId === localActivityId(workspace) && w.runId !== undefined ? [fromWorker(namedRun(w.runId, w.sessionId, kept, 'session', ranAgent(w)), w)] : []));
  const shells = keptTerminalsIn(state.terminals, localActivityId(workspace)); // #696: numbered among the kept ones
  const live = shells.filter((t) => t.asleep === undefined);
  return [...sessions, ...live.map((t) => terminalRun(state, t, shells))];
}

/** The pty id of `name`'s live run on the task (#353), undefined while it has none: its item then reads Parar <name> and stops that run. */
export const liveCommand = (task: Task, state: Pick<State, 'terminals' | 'activities' | 'activityRecords'>, name: string): string | undefined =>
  terminalsOf(state, task).find((t) => t.command === name)?.terminalId;

/** The popup's local switch applied to an activity (#444, #573, #629): true sets it, false drops it, undefined (no popup) keeps it. */
export function withLocal(activity: Activity, local: boolean | undefined): Activity {
  if (local === undefined) return activity;
  const { local: _was, ...rest } = activity;
  return local ? { ...rest, local: true } : rest;
}

/** The popup's base applied to an activity (#131, #629): null (the popup's default) drops a saved one, undefined (no popup) keeps it. */
export function withBase(activity: Activity, base: TaskBase | null | undefined): Activity {
  if (base === undefined) return activity;
  const { base: _saved, ...unbased } = activity;
  return base === null ? unbased : { ...unbased, base };
}
