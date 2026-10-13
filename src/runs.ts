import { randomUUID } from 'node:crypto';
import { AGENTS, liveDefaultAgent } from './agents.js';
import { withoutHold } from './approval.js';
import { withLaunch } from './launch-pick.js';
import { pendingEnd, withoutPending } from './handoff.js';
import { activityOf, ensureLocal, localActivityId, recordTaskId, slugOf, taskOfActivity, taskOfWorker, withActivity, withLocalActivities } from './activities.js';
import { markFreeRun, sessionBaseline, touchFreeSession, withoutSession, withResult } from './record-kit.js';
import { canOpenSession, inAction, sessionsOf, taskId, runningFirst, stageOf, continuable } from './tasks.js';
import { forgetTerminals, slept, terminalSlug } from './terminal-runs.js';
import { capturable, liveRuns, stageSession, startMode } from './task-runs.js';
import { clearedError, dropWorker, ensureActivity, releaseWorker, liveWorker, none, occupy, type Reduced, releaseRun, slugTaken, stoppedWork, takeWorker, withError } from './reducer-kit.js';
import { haltCommands } from './stage-commands.js';
import { advance, type EndOf, take } from './transit.js';
import { exitOf, transitionByKey } from './transitions.js';
import { haltCi, uncollected } from './stage-ci.js';
import type { Activity, Task, CloseAction, Effect, HiveEvent, SleepCause, Terminal, Worker, State } from './types.js';
import { openingSignal } from './signals.js';

// The rules of one flow to start and stop a task (#283), kept out of orchestrator.ts, which was over 800 lines. Pure: every function returns
// new objects.

// Frees a live worker (#248): its time joins the task up to `end`; a stage run drops its hold on the activity and, with `stop`, leaves it
// stopped. A free session holds no activity field.
function closeRun(state: State, worker: Worker, end: number, stop: boolean): State {
  const released = releaseRun(state, worker, end);
  const workers = releaseWorker(state.workers, worker);
  const task = worker.freeSession ? undefined : taskOfWorker(released, worker);
  if (!task) return { ...released, workers };
  const freed = withoutHold(dropWorker(released, task), task); // no worker holds a Stop any more (#268)
  const live = activityOf(freed, taskId(task));
  return { ...(live ? withActivity(freed, stop ? stoppedWork(live) : live) : freed), workers };
}

/** The only way a user ends a run (#283), and hive_stop (#314). The process is killed and the worker frees on the exit that follows, as today. A
 * stage run leaves its task stopped at once, so no fill picks it up between the kill and the exit; a free session only dies. With
 * `close` the task's item is closed after the kill, whatever the run; the source's own automation moves it. `cause` marks the worker so its
 * exit records why it slept (#672); a plain terminal sleeps instead (#696). Unknown worker: nothing. */
export function stop(state: State, ptyId: string, close?: CloseAction, cause?: SleepCause): Reduced {
  const staged = state.activities.find((a) => a.commands?.ptyId === ptyId);
  if (staged) return haltCommands(state, staged.id); // #755: a commands stage's pty: killed, no verdict; a cause or a close means nothing to it
  const terminal = state.terminals.find((t) => t.terminalId === ptyId && t.asleep === undefined);
  // #696: a plain terminal sleeps, its cwd read first; a command's run (#300) ends, and leaves on its exit
  if (terminal) return { state, effects: [terminal.command === undefined ? { type: 'readCwd', terminalId: ptyId } : { type: 'kill', slug: terminalSlug(state, terminal), ptyId }] };
  const worker = liveWorker(state, ptyId);
  if (!worker) return none(state);
  // #696: a captured session's claude runs in a terminal's pty: killed by its run's MCP config path, the terminal stays; no sleep cause, it has no tab
  if (worker.terminalId !== undefined) return { state, effects: [{ type: 'killCaptured', ptyId }] };
  const marked: State = cause === undefined ? state : { ...state, workers: state.workers.map((s) => (s === worker ? { ...s, ending: cause } : s)) };
  const task = taskOfWorker(marked, worker);
  const kill: Effect = { type: 'kill', slug: task ? slugOf(marked, taskId(task)) : '', ptyId };
  const closing: Effect[] = task && close ? [{ type: 'sourceAction', itemId: task.item.itemId, taskId: taskId(task), action: close }] : [];
  if (!task || worker.freeSession) return { state: marked, effects: [kill, ...closing] };
  const live = activityOf(marked, taskId(task));
  if (!live) return { state: marked, effects: [kill, ...closing] }; // a stage run always has its activity (#629)
  if (worker.status === 'approval') { // a held Stop (#268): answered with no decision first; the stage reached hive_done, so the task is not stopped
    return { state: withoutHold(marked, task), effects: [{ type: 'release', ptyId }, kill, ...closing] };
  }
  return { state: withActivity(marked, stoppedWork(live)), effects: [kill, ...closing] };
}

/** A run ended without a Stop that finished its stage (a kill, a closed tab, a crash): the worker frees and the run's time joins the task up to
 * `end`. A stage run that had not reached hive_done leaves its task stopped (#283): no more self-restart under green. While a Quit is under
 * way every exit is ignored, so its kills leave the state as the next boot must read it. */
export function exit(state: State, ptyId: string, end = Date.now()): Reduced {
  if (state.cleanStop) return none(state);
  const terminal = state.terminals.find((t) => t.terminalId === ptyId);
  if (terminal?.command !== undefined) return none({ ...state, terminals: state.terminals.filter((t) => t !== terminal) }); // a command's run holds nothing else (#283)
  if (terminal) return none(terminal.asleep ? state : slept(state, terminal)); // #696: its shell ended by itself: it sleeps on the cwd it held
  const worker = liveWorker(state, ptyId);
  return worker ? none(closeRun(state, worker, end, !worker.done)) : none(state);
}

/** The server's close(), before its kills (#283): every stop path, POST /stop, SIGTERM and SIGINT alike. */
export const quit = (state: State): Reduced => none({ ...state, cleanStop: true });

/** The crash popup closed (#283). */
export function dismissCrash(state: State): Reduced {
  const { crash: _crash, ...rest } = state;
  return none(rest);
}

const holding = (s: Worker): boolean => s.status === 'approval'; // a Stop held for approval (#268): its stage reached hive_done
// A leaving write in flight when the Hive died never answers (#286): the task carries this until the user starts it again or closes it.
const LEAVING_LOST = 'a ação na source não terminou';

// Neither deleting nor a setup survives a boot (#351, #629); a commands stage died with the Hive, its pty with it: stopped, with no verdict (#755).
// A wait for CI holds no process: it is kept, its log fetch dropped, and the next tick reads on (#834)
const bootedWork = ({ deleting: _deleting, setup: _setup, commands, ci, ...activity }: Activity): Activity => {
  const kept: Activity = ci === undefined ? activity : { ...activity, ci: uncollected(ci) };
  return commands === undefined ? kept : stoppedWork(kept);
};

/**
 * Every run died with the Hive. Each worker closes at its last hook (#248), every plain terminal sleeps and a command's run goes (#696), and a restart never shuts the computer down (#233).
 * - After a Quit (cleanStop) a stage run's task keeps its activity, not stopped, so yellow resumes it (#224, #727).
 * - After a crash each task a stage run held is stopped and listed in `crash`, which the source shows until the user closes it (#283).
 * - Every boot opens on signals.onOpen (#727): yellow, green, or the saved signal under last; a saved red always opens red.
 * - A workerId with no occupied worker behind it is cleared, and a delete activity in flight never answers: its mark drops, as a worktree setup's does (#351). A source action in flight
 *   never answers either (#286): the leaving mark drops and the task says so.
 * - A task whose Stop was held for approval (#268) is neither stopped nor listed: it still awaits the user.
 */
export function boot(state: State): Reduced {
  const { shutdown: _shutdown, keepAwake: _keepAwake, cleanStop, ...rest } = state; // #226: a Mac that never sleeps without the user knowing is the worst case
  const occupied = state.workers.filter((s) => s.status !== 'empty' && s.runId !== undefined);
  const crashed = cleanStop ? [] : occupied.filter((s) => !holding(s)).flatMap((s) => {
    const task = s.freeSession ? undefined : taskOfWorker(state, s);
    return task ? [taskId(task)] : [];
  });
  const terminals = state.terminals.flatMap((t): Terminal[] => (t.command === undefined ? [{ ...t, asleep: true }] : [])); // #696: kept, with no pty
  const start: State = { ...rest, signal: openingSignal(state.signal, state.signals.onOpen), terminals }; // #727
  const closed = occupied.reduce((acc, worker) => closeRun(acc, worker, Date.parse(worker.seenAt ?? worker.startedAt ?? ''), !cleanStop && !holding(worker)), start);
  const held = new Set(closed.workers.flatMap((s) => (s.status !== 'empty' ? [s.id] : [])));
  const tasks = closed.tasks.map(({ leaving: _leaving, ...c }) => c);
  const activities = closed.activities.map(bootedWork).map((a) => (a.workerId !== undefined && !held.has(a.workerId) ? { ...a, workerId: undefined } : a));
  const unheld: State = { ...closed, tasks, activities, ...(crashed.length > 0 ? { crash: { at: new Date().toISOString(), tasks: crashed } } : {}) };
  const lost = closed.tasks.filter((c) => c.leaving).reduce((acc, c) => withError(acc, c, LEAVING_LOST), unheld);
  return none(withLocalActivities(lost));
}

// What a run by hand shares with start (#283): the task's last failure is cleared and it tries again; the slug refusal comes before any worker.
function runByHand(state: State, task: Task, run: 'stage' | 'continue'): Reduced {
  const stage = stageOf(state.stages, task.stage);
  if (!stage) return none(state);
  const retried = clearedError(state, task);
  const taken = slugTaken(retried, task);
  if (taken) return none(taken);
  const { state: opened, index } = takeWorker(retried);
  return occupy(opened, index, task, stage, 'manualStart', run, run === 'continue' ? 'continue' : undefined);
}

/** Continue (#283): the stage's latest session resumed with the continue prompt, whatever the stage's session policy, past the signal, the
 * cap and the budget like a start. Only while startMode offers it, and never while a live run holds that session (`live`): a second process
 * would open the same transcript, so the UI focuses that run instead. */
// `continue` is a reserved word, so the reducer is named continueStage (#570)
export function continueStage(state: State, itemId: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === itemId);
  const mode = task && startMode(task, state);
  const session = task && typeof mode === 'object' && mode.continue && mode.live === undefined ? stageSession(task, state, task.stage) : undefined; // #812: none after a free run
  const born = task && session && ensureActivity(state, task); // a deleted activity's session resumes in a new one
  if (!task || !session || !born) return none(state);
  return runByHand(withActivity(born.state, { ...born.activity, sessionId: session.id }), task, 'continue');
}

const unmarked = ({ deleting: _deleting, ...activity }: Activity): Activity => activity;
const unqueued = ({ handover: _handover, handoffPending: _handoffPending, handoffFeedback: _handoffFeedback, ...activity }: Activity): Activity => activity;
const unresumed = ({ sessionId: _sessionId, ...activity }: Activity): Activity => activity;

/** Restart (#283): the stage's prompt in a new session, once the server brought the worktree back to the stage's starting commit; `branch` is
 * the new branch it checked out when the old one was published. Only while startMode offers it. */
export function restart(state: State, itemId: string, branch?: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === itemId);
  const found = activityOf(state, itemId);
  const activity = found?.deleting ? unmarked(found) : found; // the mark `restarting` set goes with the restart, run or ignored (#283)
  const base = activity && activity !== found ? withActivity(state, activity) : state;
  const mode = task && startMode(task, base);
  if (!task || typeof mode !== 'object' || !mode.restart) return none(base);
  // A restart runs the stage afresh: queued feedback answered the run it throws away (#268), its stage end asks for the handoff again (#692);
  // the new branch lives on the activity (#629)
  const fresh = activity && { ...unqueued(activity), ...(branch === undefined ? {} : { branch }) };
  return runByHand(fresh ? withActivity(base, fresh) : base, task, 'stage');
}

/** Restart's git is about to run (#283): the task is marked deleting, the way the delete-activity route marks it, so a start, a continue, a
 * session or the fill cannot land on the worktree the git resets. Only while Restart is offered and no session or terminal runs on the task. The
 * restart that follows drops the mark; a git failure drops it through activityKept. */
export function restarting(state: State, itemId: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === itemId);
  const mode = task && startMode(task, state);
  const activity = task && activityOf(state, itemId);
  if (!task || !activity || typeof mode !== 'object' || !mode.restart || liveRuns(task, state).length > 0) return none(state);
  return none(withActivity(state, { ...activity, deleting: true }));
}

/** #619: a stage's end captures the checkpoint that ended before anything the end emits: the server runs a batch's effects in order, so the capture
 * reads the worktree before a continue answers the Stop. The activity as it stood before the end, its stageStart still the checkpoint's. An
 * activity capturable refuses leaves the reduction as it was. */
export function capturedFirst(before: State, task: Task, reduced: Reduced): Reduced {
  const activity = activityOf(before, taskId(task));
  if (!capturable(activity)) return reduced;
  return { state: reduced.state, effects: [{ type: 'captureCheckpoint', activity, task, stage: task.stage, ended: 'done' }, ...reduced.effects] };
}

/** The server captured a restore point (#619): appended in capture order; an n the activity already lists, or an activity gone, changes nothing. */
export function checkpointCaptured(state: State, { activityId, checkpoint }: Extract<HiveEvent, { type: 'checkpointCaptured' }>): Reduced {
  const activity = state.activities.find((a) => a.id === activityId);
  if (!activity || activity.checkpoints?.some((a) => a.n === checkpoint.n)) return none(state);
  return none(withActivity(state, { ...activity, checkpoints: [...(activity.checkpoints ?? []), checkpoint] }));
}

/** A restore's git is about to run (#619): the task is marked deleting, as restarting marks it, so nothing starts on the worktree meanwhile. In
 * any stage, with or without a recorded start; only while no run of any kind (stage run, session, terminal, command) holds the task and no other
 * git job, setup or stage action does. restored or restoreFailed drops the mark. */
export function restoring(state: State, itemId: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === itemId);
  const activity = activityOf(state, itemId);
  if (!task || !activity || activity.deleting || activity.setup || inAction(activity) || liveRuns(task, state).length > 0) return none(state);
  return none(withActivity(state, { ...activity, deleting: true }));
}

/** The restore's git ended well (#619): the mark goes and a new -r<n> is recorded as Restart records it; the stage, the column, stageStart and the
 * stopped mark stay as they are, and nothing starts. */
export function restored(state: State, { itemId, branch }: Extract<HiveEvent, { type: 'restored' }>): Reduced {
  const found = activityOf(state, itemId);
  if (!found?.deleting) return none(state);
  return none(withActivity(state, { ...unmarked(found), ...(branch === undefined ? {} : { branch }) }));
}

/** The restore's git failed (#619): only the mark goes. */
export function restoreFailed(state: State, itemId: string): Reduced {
  const found = activityOf(state, itemId);
  return found?.deleting ? none(withActivity(state, unmarked(found))) : none(state);
}

// The stage that ended where `stage` starts (#580): the latest-used session's last stage other than `stage`, walking back by last use while a
// session ran only `stage`. A tie keeps the later-listed session first. Undefined when the task ran no other stage. Read at every stage run's
// start, a restart's too, so a restart keeps the label and clearing a session later never changes it. Every record of the task counts (#629).
function previousStage(state: State, task: Task, stage: string): string | undefined {
  const byUse = [...sessionsOf(state, taskId(task))].reverse().sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return byUse.map((s) => [...s.stages].reverse().find((name) => name !== stage)).find((name) => name !== undefined);
}

/** The server read HEAD as a stage run started (#283): kept on the activity while its task is still in that stage, with the stage that ended
 * there (#580); a task that moved on, or an activity gone meanwhile, ignores it (#629). */
export function stageStarted(state: State, { activityId, stage, commit }: Extract<HiveEvent, { type: 'stageStarted' }>): Reduced {
  const activity = state.activities.find((a) => a.id === activityId);
  const task = activity && taskOfActivity(state, activityId);
  if (!activity || task?.stage !== stage) return none(state);
  const after = previousStage(state, task, stage);
  return none(withActivity(state, { ...activity, stageStart: { stage, commit, ...(after === undefined ? {} : { after }) } }));
}

/** A session's limpar in the panel (#304): that one session is forgotten, and the activity's sessionId with it when it is that one. The stages it ran read
 * as not run again only when no other session lists them, which sessionsOf gives. A session continuable does not offer (unknown, or held by a
 * live run) and an unknown task: the same state. */
export function clearSessions(state: State, { activityId, sessionId }: Extract<HiveEvent, { type: 'clearSessions' }>): Reduced {
  const id = recordTaskId(state, activityId); // a record id: a deleted activity's kept session clears too (#629)
  const task = state.tasks.find((c) => taskId(c) === id);
  if (!task || !continuable(task, state).some((s) => s.id === sessionId)) return none(state);
  const live = activityOf(state, id);
  const forgot = live?.sessionId === sessionId ? withActivity(state, unresumed(live)) : state;
  return none(withoutSession(forgot, task, sessionId));
}

// Every run opened on a task puts it on top of its stage, last among the live tasks, as a stage start does (#117, #356). A task already
// there keeps the same tasks array.
const onTop = ({ state, effects }: Reduced, id: string): Reduced => ({ state: { ...state, tasks: runningFirst(state.tasks, id, state) }, effects });

/** The terminal panel's + (#292): a plain shell in a workspace's main checkout, with no task, no worker and no cap, like a task's terminal (#283).
 * An unknown workspace opens nothing. No task, so nothing moves to the top of a stage (#356). */
export function openProjectShell(state: State, { project, cwd }: Extract<HiveEvent, { type: 'openProjectShell' }>): Reduced {
  if (!state.workspaces.includes(project)) return none(state);
  const shell: Terminal = { terminalId: randomUUID(), activityId: localActivityId(project), startedAt: new Date().toISOString(), cwd }; // #696: the checkout
  const local = ensureLocal(state, project);
  const activity = local.activities.find((a) => a.id === shell.activityId);
  if (!activity) return none(state);
  return { state: { ...local, terminals: [...local.terminals, shell] }, effects: [{ type: 'spawnTerminal', terminal: shell, activity }] };
}

/** A terminal on a task (#283, #570): no worker and no cap; the pool runs it in a pty (#251), so Stop, Quit, shutdown and closing the task end
 * it. Its own event, since a terminal is not a session. Only on a task canOpenSession allows, with its worktree on disk (#208); it puts the
 * task on top of its stage, as a start does (#356). With a command (#300) it keeps only the name: the pool looks the line up when it starts,
 * so a stale click never runs something else. It starts in the event's cwd, a folder of the worktree the files tree asked for (#818), else
 * the worktree. A refused open changes nothing. */
export function openTerminal(state: State, { activityId, command, cwd }: Extract<HiveEvent, { type: 'openTerminal' }>): Reduced {
  const id = recordTaskId(state, activityId);
  const task = state.tasks.find((c) => taskId(c) === id);
  const activity = activityOf(state, id); // a worktree on disk is a live activity's (#629)
  if (!task || !canOpenSession(task, activity) || activity?.worktree === undefined || activity.worktreeGone) return none(state);
  const terminal: Terminal = { terminalId: randomUUID(), activityId: activity.id, startedAt: new Date().toISOString(), cwd: cwd ?? activity.worktree, ...(command === undefined ? {} : { command }) }; // #696: it starts in the worktree
  return onTop({ state: { ...state, terminals: [...state.terminals, terminal] }, effects: [{ type: 'spawnTerminal', terminal, activity, task }] }, id);
}

/**
 * Abrir sessão (#283) on any task canOpenSession allows, and the sidebar's session (#208): the user's own session in a worker of its own appended
 * to state.workers (#459), a free session, outside the cap, past the signal and the budget, with the MCP on. The activity's workerId stays the stage
 * run's, so many sessions may hold one task. A resume must be one continuable offers: a `repo` one runs in the workspace's main repo and needs no
 * worktree (#208); anything else needs the task's worktree on disk (the route creates or recreates it first). It puts the task on top of its
 * stage, as a start does (#356); a refused open changes nothing. A terminal is openTerminal's (#570).
 */
export function openSession(state: State, { activityId, continueId, prompt, agent: asked, launch: picked }: Extract<HiveEvent, { type: 'openSession' }>): Reduced {
  const id = recordTaskId(state, activityId); // a record id: a kept session opens in the task's live activity, born when none (#629)
  const task = state.tasks.find((c) => taskId(c) === id);
  const live = activityOf(state, id);
  if (!task || !canOpenSession(task, live)) return none(state);
  const session = continueId === undefined ? undefined : continuable(task, state).find((s) => s.id === continueId);
  if (continueId !== undefined && !session) return none(state);
  if (!session?.repo && (live?.worktree === undefined || live.worktreeGone)) return none(state); // #208
  const born = ensureActivity(state, task);
  if (!born) return none(state);
  const agent = session?.agent ?? asked ?? liveDefaultAgent(state); // #925: a resume runs its session's own agent, a new session the one asked for
  const launch = continueId === undefined ? picked : session?.launch; // #257: a resume runs with what its record kept, never the event's
  // #931: a new session runs under the Hive's id only for an agent that takes one; Codex's comes with its first SessionStart
  const sessionId = continueId ?? (AGENTS[agent].canChooseSessionId ? randomUUID() : undefined);
  const startedAt = new Date().toISOString();
  // Appended, never a free worker (#459): a free worker is the fill's, so taking one would still cost the automation a worker; releaseWorker drops it
  const worker: Worker = {
    id: randomUUID(), runId: randomUUID(), activityId: born.activity.id, agent, status: 'working', startedAt, lastEvent: { kind: 'manualStart' },
    ...(sessionId === undefined ? {} : { sessionId }), freeSession: true, ...withLaunch(launch),
    ...sessionBaseline(born.state, task, sessionId), // a resume counts only what it adds (#248)
  };
  const added: State = { ...born.state, workers: [...born.state.workers, worker] };
  // a new session is appended free, a resumed one only used again (#236, #812); one with no id yet only marks the stage (#931)
  const touched = sessionId === undefined ? markFreeRun(added, task) : touchFreeSession(added, task, sessionId, startedAt, agent, launch);
  return onTop({
    state: touched,
    effects: [{
      // #812: the activity as stored, its free run's mark included
      type: 'spawnSession', worker, activity: activityOf(touched, id) ?? born.activity, task, ...(sessionId === undefined ? {} : { sessionId }), continues: continueId !== undefined, ...(session?.repo ? { repo: true } : {}),
      ...(prompt === undefined ? {} : { prompt }), // #758: no rule, the event's prompt rides along
    }],
  }, id);
}

/** hive_done in a free session (#283): the stage ends at once, as a stage run's end does (the transition's sources written, its destination entered,
 * the result merged), with no kill. The session stays open until the user stops it, and the fill cannot take a task a worker holds. A stage run
 * that also holds the task is left running: its own later stage end applies from whatever stage the task is in then (finish reads
 * task.stage), as today. In an approval stage the task awaits the user instead (#268), with the session still open. */
export function freeSessionDone(state: State, worker: Worker, result?: Record<string, unknown>, verdict?: string): Reduced {
  const task = taskOfWorker(state, worker);
  return task ? capturedFirst(state, task, freeSessionEnd(state, worker, task, result, verdict)) : none(state); // #619
}

// The body freeSessionDone had from `const merged` on (#283, #268, #134, #692, #812), unchanged
function freeSessionEnd(state: State, worker: Worker, task: Task, result?: Record<string, unknown>, verdict?: string): Reduced {
  const merged = result ? withResult(state, task, result) : state;
  const live = activityOf(merged, taskId(task));
  const pending = transitionByKey(state.transitions, live?.handoffPending); // #692, #134: the transition the handoff waited on
  const ended: EndOf = verdict === undefined ? { trigger: 'done' } : { trigger: 'verdict', verdict };
  const end: EndOf = worker.sessionId === undefined ? ended : { ...ended, sessionId: worker.sessionId }; // #812: this session ended the stage
  const routed = verdict !== undefined && exitOf(state, task.stage, 'verdict', verdict) !== undefined; // #134: a routed verdict waits for nobody
  if (pending === undefined && !routed && stageOf(state.stages, task.stage)?.approval) { // the stage waits for Aprovar (#268), on the session's activity; no Stop to hold
    const approval = { since: new Date().toISOString(), ...(worker.sessionId === undefined ? {} : { sessionId: worker.sessionId }) }; // #812: feedback and the handoff go to it
    return none(live ? withActivity(merged, { ...live, approval }) : merged);
  }
  const { state: advanced, effects } = pending ? take(withoutPending(merged, task), task, pending, pendingEnd(live, end)) : advance(merged, task, end); // #134: with the feedback it waited on
  return { state: advanced, effects };
}

/** Deleting an activity or dropping its task forgets its terminals (#573, #696): every terminal its activity keeps leaves the state at once,
 * a live one killed (git never runs under one), and every plain one's files go. The exit that follows finds no terminal. A commands stage in
 * flight is stopped with them (#755), its pty killed, with no verdict. A wait for CI ends with them, with no verdict (#834). */
export function closeTerminals(state: State, task: Task): Reduced {
  const activity = activityOf(state, taskId(task));
  const slug = slugOf(state, taskId(task));
  const closed = forgetTerminals(state, activity === undefined ? [] : state.terminals.filter((t) => t.activityId === activity.id), () => slug);
  const halted = activity === undefined ? none(closed.state) : haltCommands(closed.state, activity.id);
  const unwaited = activity === undefined ? halted.state : haltCi(halted.state, activity.id); // #834
  return { state: unwaited, effects: [...closed.effects, ...halted.effects] };
}

/** The first /tasks/:id/open is about to make the worktree (#629): the task's activity is born now, so its setup and worktreeReady have an id
 * to act on. Only on a task canOpenSession allows; one that has its activity keeps it. */
export function createActivity(state: State, { taskId: id }: Extract<HiveEvent, { type: 'createActivity' }>): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  if (!task || !canOpenSession(task, activityOf(state, id))) return none(state);
  return none(ensureActivity(state, task)?.state ?? state);
}
