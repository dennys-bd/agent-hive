// What the Activities tab lists (#457, redesign 03): every workspace's local activity (#590), then every task with a live run or a worktree,
// whether the automation or the user started it. Derived from the State the dashboard already receives; nothing of it is stored.
import { type LiveRun, liveRuns, localRuns, namedRun, terminalLabel } from '../../task-runs';
import { canOpenSession, sessionsOf, taskLabel } from '../../tasks';
import { activityOf, keptTerminalsIn, localActivityId, recordOf, recordsOf, workersIn } from '../../activities';
import type { Activity as LiveActivity, ActivityRecord, Task, TaskPr, Session, SleepCause, SleptRun, Terminal, Worker, State, Status } from '../../types';
import { type CenterLayout, groupsOf } from '@/lib/center-layout';
import { localReview, type ReviewKey, taskReview } from '@/lib/review-events';
import { isLive, taskState } from '@/lib/task-state';

/** A run that ended with its session kept (#672): its tab stays, sleeping, until it closes or the session continues. `run` names it as its
 * live run was named. A sleeping terminal is one too (#696), with no session. */
export interface SleepingRun { run: LiveRun; sessionId?: string; cause?: SleepCause } // no sessionId: a sleeping terminal (#696), which wakes in its own id; or, with run.agent set, a session slept before its first prompt (#931), which wakes into a new one

/** A terminal an activity keeps (#696), live or sleeping: its label (Terminal, Terminal N, as its tab reads), its number once there are
 * several (what its line reads), and whether it sleeps. */
export interface KeptTerminal { terminalId: string; label: string; n?: number; asleep: boolean }

/** One agent run of an activity (redesign 03): its run and the status of the worker it runs in. Terminals have none, so they are not here. */
export interface ActivitySession {
  run: LiveRun; status: Status;
  sessionId?: string; // the worker's, what a review names a session by (#591)
}

/** One session of a task's activity (#614): a kept session, the live agent run holding it, or both; at least one is set. `status` is the
 * run's while it works or waits, `empty` otherwise (no run, or a held approval run, #663): the sidebar reads that as sleeping. */
export interface TaskActivitySession { session?: Session; run?: LiveRun; status: Status }

/** A task's activity (#457): its live activity and that activity's record (#629), every record of the task oldest first, its live runs in
 * liveRuns order (the stage run first), its sessions (#614: every kept one, then the live runs not kept yet), its status, the oldest and the
 * newest start of its workers, and whether one of its workers runs as automation (a worker that is not a free session, #459). The status is
 * its task's state (#663), review and approval included once no session works; `empty` with none (a task running terminals only, or nothing,
 * #647). */
export interface TaskActivity {
  kind: 'task'; activity: LiveActivity; record: ActivityRecord; records: ActivityRecord[]; task: Task; runs: LiveRun[]; sessions: TaskActivitySession[];
  slept?: SleepingRun[]; // #672: absent reads as none
  terminals?: KeptTerminal[]; sleeping?: boolean; // #696: activitiesOf sets both; a test's literal may leave them out
  status: Status; startedAt?: string; lastStartedAt?: string; worker: boolean;
}

/** A kept local session as the sidebar and the local menu list it (#590): the session, and the live run continuing it with that run's status;
 * `empty` (parada) while none does. */
export interface LocalSession { session: Session; run?: LiveRun; status: Status }

/** A workspace's local activity (#590): one per workspace, permanent, holding no task. Its live activity and record (#629), its live runs
 * (its claude sessions, then its terminals), its agent sessions with their status as a task's, and its kept sessions, oldest first. */
export interface LocalActivity { kind: 'local'; activity: LiveActivity; record: ActivityRecord; workspace: string; runs: LiveRun[]; sessions: ActivitySession[]; kept: LocalSession[]; slept?: SleepingRun[]; terminals?: KeptTerminal[]; sleeping?: boolean }

export type Activity = TaskActivity | LocalActivity;

/** What a new run opens in (#590): a task, or a workspace's local activity. Every Activity is one. */
export type RunTarget = Pick<TaskActivity, 'kind' | 'task' | 'activity'> | Pick<LocalActivity, 'kind' | 'workspace' | 'activity'>;

export const isTask = (activity: Activity): activity is TaskActivity => activity.kind === 'task';

/** A local activity's key (#590): what its pick, its sidebar row and its center layout (hive.centerLayouts) go by. */
export const localKey = (workspace: string): string => `local/${workspace}`;

/** An activity's identity (#590): a task's item id, or localKey for a workspace's local activity. */
export const activityKey = (target: RunTarget): string => (target.kind === 'local' ? localKey(target.workspace) : target.task.item.itemId);

/** The review an activity's design pane reads and writes (#345): its task's, or its workspace's local one (#344). */
export const reviewKeyOf = (target: RunTarget): ReviewKey => (target.kind === 'local' ? localReview(target.workspace) : taskReview(target.task.item.itemId));

/** What an activity's panes read before their own name (#251): its task's label, or its workspace for a local activity (#590). The design
 *  panel's sessions line names the activity by it too (#345). */
export const activityTitle = (target: RunTarget): string => (target.kind === 'task' ? taskLabel(target.task) : target.workspace);

/** Whether a new run may open in it (#590): a local activity always; a task by the rule Abrir sessão reads (#491). */
export const canOpenIn = (target: RunTarget): boolean => target.kind === 'local' || canOpenSession(target.task, target.activity);

export type Slice = Pick<State, 'tasks' | 'workers' | 'terminals' | 'workspaces' | 'activities' | 'activityRecords' | 'slept'> & Partial<Pick<State, 'stages'>>; // #264: stages let taskState see the queue, so a queued task with an open PR is not review

// ISO timestamps order as strings
const newest = (times: string[]): string | undefined =>
  times.reduce<string | undefined>((max, at) => (max === undefined || at > max ? at : max), undefined);
const oldest = (times: string[]): string | undefined =>
  times.reduce<string | undefined>((min, at) => (min === undefined || at < min ? at : min), undefined);

// A worktree still on disk (or the checkout, #444) keeps the task an activity with nothing running (redesign 03); its removal drops it
const hasWorktree = (activity: LiveActivity): boolean => activity.worktree !== undefined && !activity.worktreeGone;

// The agent runs among `runs`, each with its worker's status: a terminal has no worker (redesign 03)
function agentSessions(runs: LiveRun[], workers: Worker[]): ActivitySession[] {
  return runs.flatMap((run): ActivitySession[] => {
    const worker = workers.find((s) => s.runId === run.ptyId);
    return worker === undefined ? [] : [{ run, status: worker.status, ...(worker.sessionId === undefined ? {} : { sessionId: worker.sessionId }) }];
  });
}

// The session a worker's run holds: its own once SessionStart told it, a stage run's activity sessionId before (#629), as workerRun and
// sessionRefOf read it. Matching on worker.sessionId alone would list a starting stage run's session twice, once sleeping and once not kept yet (#614)
const heldId = (activity: LiveActivity, worker: Worker): string | undefined => worker.sessionId ?? (worker.freeSession ? undefined : activity.sessionId);

// A session says only what its run does (#663): working or waiting, else empty, so a held approval run reads sleeping. Approval and review
// are the task's state
const sessionStatus = (worker: Worker): Status => (isLive(worker.status) ? worker.status : 'empty');

// Every kept session of the task, oldest first as sessionsOf lists them, each with the live agent run holding it; then the live agent runs
// whose session is not kept yet, in liveRuns order (#614)
function taskSessions(activity: LiveActivity, runs: LiveRun[], workers: Worker[], kept: Session[]): TaskActivitySession[] {
  const held = runs.flatMap((run) => {
    const worker = workers.find((s) => s.runId === run.ptyId);
    return worker === undefined ? [] : [{ run, status: sessionStatus(worker), id: heldId(activity, worker) }];
  });
  const listed = kept.map((session): TaskActivitySession => {
    const live = held.find((h) => h.id === session.id);
    return live ? { session, run: live.run, status: live.status } : { session, status: 'empty' };
  });
  const unkept = held.filter((h) => !kept.some((s) => s.id === h.id)).map(({ run, status }): TaskActivitySession => ({ run, status }));
  return [...listed, ...unkept];
}

// The activity's kept terminals in open order (#696), a command's run left out: numbered once there are several, as their tabs are
function keptOf(terminals: Terminal[], activityId: string): KeptTerminal[] {
  const kept = keptTerminalsIn(terminals, activityId);
  return kept.map((t, i) => ({ terminalId: t.terminalId, label: terminalLabel(t, kept), asleep: t.asleep === true, ...(kept.length > 1 ? { n: i + 1 } : {}) }));
}

// Sleeping (#696): derived, never stored: the activity keeps something (a session, a terminal or a sleeping run, #931: one slept before its
// first prompt keeps no session) and no session run nor terminal is live
const isSleeping = (runs: LiveRun[], sessions: number, terminals: KeptTerminal[], slept: SleepingRun[]): boolean =>
  runs.length === 0 && (sessions > 0 || terminals.length > 0 || slept.length > 0);

// A sleeping terminal's tab (#696): a sleeping run with no session, so the center draws and wakes it as #672 does an agent's
const sleepingTerminals = (terminals: KeptTerminal[]): SleepingRun[] =>
  terminals.filter((t) => t.asleep).map((t) => ({ run: { ptyId: t.terminalId, label: t.label, kind: 'terminal' } }));

// The sleeping runs of one activity (#672), named by the session they hold, as their live run was
function sleepingIn(slept: readonly SleptRun[] | undefined, isOwn: (run: SleptRun) => boolean, sessions: Session[]): SleepingRun[] {
  return (slept ?? []).filter(isOwn).map((s) => ({ run: namedRun(s.ptyId, s.sessionId, sessions, s.kind, s.agent), sessionId: s.sessionId, ...(s.cause === undefined ? {} : { cause: s.cause }) }));
}

function taskActivityOf(task: Task, state: Slice): TaskActivity | undefined {
  const activity = activityOf(state, task.item.itemId);
  const record = activity && recordOf(state, activity.id);
  if (!activity || !record) return undefined;
  const runs = liveRuns(task, state, { commands: false }); // a run command has no terminal to show (#353)
  const kept = sessionsOf(state, task.item.itemId);
  const terminals = keptOf(state.terminals, activity.id); // #696
  const slept = [...sleepingIn(state.slept, (s) => s.taskId === task.item.itemId, kept), ...sleepingTerminals(terminals)]; // #672, #696
  if (runs.length === 0 && slept.length === 0 && terminals.length === 0 && !hasWorktree(activity) && activity.commands === undefined && activity.ci === undefined) return undefined; // as before #629: a worktree on disk, a run or a kept terminal (#696) lists it; a commands stage in flight too (#755), so its locked tab has an activity; a wait for CI too (#834), so the waiting task shows in the bar and its Stop has an activity
  const workers = workersIn(state.workers, activity.id);
  const current = taskState(task, state); // the task's state (#663): what the border, the groups and the search show
  const starts = workers.flatMap((worker) => (worker.startedAt === undefined ? [] : [worker.startedAt]));
  return {
    kind: 'task', activity, record, records: recordsOf(state, task.item.itemId), task, runs, slept,
    sessions: taskSessions(activity, runs, workers, kept), terminals, sleeping: isSleeping(runs, kept.length, terminals, slept), status: current === 'new' ? 'empty' : current, // a listed activity's task is never new: it has one
    startedAt: oldest(starts), lastStartedAt: newest(starts), worker: workers.some((worker) => !worker.freeSession),
  };
}

// A workspace's local activity (#590, #629): its own activity and record in state.activities, its claude sessions' workers and its terminals
function localActivityOf(workspace: string, state: Slice): LocalActivity | undefined {
  const id = localActivityId(workspace);
  const activity = state.activities.find((a) => a.id === id);
  const record = recordOf(state, id);
  if (!activity || !record) return undefined;
  const runs = localRuns(workspace, state);
  const workers = workersIn(state.workers, id);
  const kept = record.sessions.map((session): LocalSession => {
    const worker = workers.find((s) => s.sessionId === session.id);
    const run = worker && runs.find((r) => r.ptyId === worker.runId);
    return worker && run ? { session, run, status: worker.status } : { session, status: 'empty' };
  });
  const terminals = keptOf(state.terminals, id); // #696
  const slept = [...sleepingIn(state.slept, (s) => s.workspace === workspace, record.sessions), ...sleepingTerminals(terminals)]; // #672, #696
  return { kind: 'local', activity, record, workspace, runs, sessions: agentSessions(runs, workers), kept, slept, terminals, sleeping: isSleeping(runs, record.sessions.length, terminals, slept) };
}

/** One local activity per workspace, in the config's order (#590), then every task's live activity with a live run or a worktree, in the
 * flow's order (state.tasks): all read from state.activities (#629). */
export const activitiesOf = (state: Slice): Activity[] => [
  ...state.workspaces.flatMap((workspace) => localActivityOf(workspace, state) ?? []),
  ...state.tasks.flatMap((task) => taskActivityOf(task, state) ?? []),
];

/** The task's activity as the Activities tab lists it (#672): what a menu sleeps a session of; undefined while the task is no activity. */
export const taskActivity = (state: Slice, task: Task): TaskActivity | undefined => taskActivityOf(task, state);

/** The status of the session `ptyId` runs (#614), a task's or a local activity's; undefined for a terminal or a run not listed. */
export function runStatus(activity: Activity, ptyId: string): Status | undefined {
  const sessions: readonly { run?: LiveRun; status: Status }[] = activity.sessions;
  return sessions.find((s) => s.run?.ptyId === ptyId)?.status;
}

/** Every PR of a task's activity, its records oldest first (#207, #629): what mostrar PR and the groups read. */
export const activityPrs = (activity: TaskActivity): TaskPr[] => activity.records.flatMap((r) => r.prs ?? []);

/** The sleeping run `ptyId` of the activity (#672), a sleeping terminal too (#696); undefined for a live run or a run gone. */
export const sleepingOf = (activity: Activity, ptyId: string): SleepingRun | undefined => activity.slept?.find((s) => s.run.ptyId === ptyId);

/** Each live or sleeping agent run's session (#696): what its center tab writes, so the tab names the session once the run is gone. */
export function runSessions(activity: Activity): Record<string, string> {
  const live = activity.kind === 'local'
    ? activity.kept.flatMap((k) => (k.run === undefined ? [] : [[k.run.ptyId, k.session.id] as const]))
    : activity.sessions.flatMap((s) => (s.run !== undefined && s.session !== undefined ? [[s.run.ptyId, s.session.id] as const] : []));
  const asleep = (activity.slept ?? []).flatMap((s) => (s.sessionId === undefined ? [] : [[s.run.ptyId, s.sessionId] as const]));
  return Object.fromEntries([...live, ...asleep]);
}

/** The kept sessions of the activity no run holds (#696): a tab naming one stays, sleeping, after a restart dropped its run. */
export const sleepingSessions = (activity: Activity): string[] => (activity.kind === 'local'
  ? activity.kept.flatMap((k) => (k.run === undefined ? [k.session.id] : []))
  : activity.sessions.flatMap((s) => (s.run === undefined && s.session !== undefined ? [s.session.id] : [])));

/** The activity with the sleeping tabs a restart left (#696): each run tab of `layout` that names a sleeping session and whose run is neither
 * live nor sleeping becomes a sleeping run with no transcript, named as its live run was. The same object back when there is none. */
export function withRestored(activity: Activity, layout: CenterLayout | undefined): Activity {
  if (layout === undefined) return activity;
  const asleep = new Set(sleepingSessions(activity));
  const shown = new Set([...activity.runs, ...(activity.slept ?? []).map((s) => s.run)].map((run) => run.ptyId));
  const sessions = activity.kind === 'local' ? activity.kept.map((k) => k.session) : activity.sessions.flatMap((s) => s.session ?? []);
  const restored = groupsOf(layout.root).flatMap((group) => group.tabs).flatMap((tab): SleepingRun[] => {
    const session = tab.kind === 'run' && !shown.has(tab.ptyId) ? sessions.find((s) => s.id === tab.sessionId && asleep.has(s.id)) : undefined;
    return session === undefined || tab.kind !== 'run' ? [] : [{ run: namedRun(tab.ptyId, session.id, sessions, 'session', session.agent), sessionId: session.id }]; // #925: its session's agent
  });
  return restored.length === 0 ? activity : { ...activity, slept: [...(activity.slept ?? []), ...restored] };
}
