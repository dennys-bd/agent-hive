import { randomUUID } from 'node:crypto';
import { isLocalActivityId, taskOfActivity } from './activities.js';
import { localSessionsOf } from './local-sessions.js';
import { touchFreeSession } from './record-kit.js';
import { none, type Reduced, releaseRun, releaseWorker } from './reducer-kit.js';
import { withLocal } from './session-copy.js';
import { canOpenSession, LOCAL_SLUG } from './tasks.js';
import type { Activity, AgentId, Effect, HiveEvent, Session, State, Terminal, Worker } from './types.js';

// #925: the shim wraps the claude CLI only (claude-shim.ts), so what it captures is Claude's
const SHIM_AGENT: AgentId = 'claude';

// Kept terminals (#696), out of runs.ts: a terminal sleeps with no pty, keeps its cwd and wakes in the same id until it is forgotten. A
// command's run (#300) is the console's, never kept. Pure: every function returns new objects.

/** A terminal's kill names its activity's slug, or the workspace shell's on a local one (#292, #629), read off its id: a removed workspace's
 * local activity is gone before its terminals are (#696). */
export const terminalSlug = (state: State, terminal: Terminal): string =>
  (isLocalActivityId(terminal.activityId) ? LOCAL_SLUG : state.activities.find((a) => a.id === terminal.activityId)?.slug ?? '');

/** The live plain terminal with that id: the only kind that sleeps. */
export const liveShell = (state: Pick<State, 'terminals'>, terminalId: string): Terminal | undefined =>
  state.terminals.find((t) => t.terminalId === terminalId && t.command === undefined && t.asleep === undefined);

/** The free sessions the shim captured in a terminal (#696) end with it: their claude dies with its shell, so their runs close as their exit
 * would. */
export function endCaptured(state: State, terminalId: string, end = Date.now()): State {
  return state.workers
    .filter((w) => w.terminalId === terminalId && w.status !== 'empty')
    .reduce((acc, w) => ({ ...releaseRun(acc, w, end), workers: releaseWorker(acc.workers, w) }), state);
}

/** Terminals leaving the state with their activity (#573, #696): the sessions captured in each end, a live one is killed (git never runs under
 * one, and no pty outlives its line) and every plain one's files go. `slug` names a kill's, read before the activity went. */
export function forgetTerminals(state: State, own: Terminal[], slug: (terminal: Terminal) => string): Reduced {
  if (own.length === 0) return none(state);
  const left: State = { ...state, terminals: state.terminals.filter((t) => !own.includes(t)) };
  return {
    state: own.reduce((acc, t) => endCaptured(acc, t.terminalId), left),
    effects: own.flatMap((t): Effect[] => [
      ...(t.asleep ? [] : [{ type: 'kill' as const, slug: slug(t), ptyId: t.terminalId }]),
      ...(t.command === undefined ? [{ type: 'dropTerminalFiles' as const, terminalId: t.terminalId }] : []),
    ]),
  };
}

/** The terminals of an activity that is gone (#696): pruneWork drops a task's once all its tasks left, withLocalActivities a removed workspace's
 * local one, and neither knows about terminals. A task activity pruneWork keeps with no task (#861) is reached from no row, so its terminals
 * go too: closeMissing and the last stage close none. `before` is the state that still had the activity, for the kill's slug. */
export function dropOrphanTerminals(state: State, before: State): Reduced {
  const ids = new Set(state.activities.filter((a) => a.kind !== 'task' || taskOfActivity(state, a.id) !== undefined).map((a) => a.id));
  return forgetTerminals(state, state.terminals.filter((t) => !ids.has(t.activityId)), (t) => terminalSlug(before, t));
}

/** `terminal` asleep in `state`, on `cwd` when one was read, else on the one it held; the sessions captured in it end. */
export function slept(state: State, terminal: Terminal, cwd?: string): State {
  const asleep: Terminal = { ...terminal, asleep: true, ...(cwd === undefined ? {} : { cwd }) };
  return endCaptured({ ...state, terminals: state.terminals.map((t) => (t === terminal ? asleep : t)) }, terminal.terminalId);
}

/** The server read the shell's cwd (or could not): the terminal sleeps on it and its pty is killed; the exit that follows finds it asleep. */
export function sleepTerminal(state: State, { terminalId, cwd }: Extract<HiveEvent, { type: 'sleepTerminal' }>): Reduced {
  const terminal = liveShell(state, terminalId);
  if (!terminal) return none(state);
  return { state: slept(state, terminal, cwd), effects: [{ type: 'kill', slug: terminalSlug(state, terminal), ptyId: terminalId }] };
}

// Whether the terminal's activity can run it again: openTerminal's checks on a task's (#208), its workspace still in the Comb on a local one
function canWake(state: State, activity: Activity): boolean {
  if (activity.kind === 'local') return state.workspaces.includes(activity.workspace);
  const task = taskOfActivity(state, activity.id);
  return task !== undefined && canOpenSession(task, activity) && activity.worktree !== undefined && !activity.worktreeGone;
}

/** A sleeping terminal spawns again in its own id, so the layout's tab, its line and its files keep pointing at it. */
export function wakeTerminal(state: State, { terminalId }: Extract<HiveEvent, { type: 'wakeTerminal' }>): Reduced {
  const terminal = state.terminals.find((t) => t.terminalId === terminalId && t.asleep === true);
  const activity = terminal && state.activities.find((a) => a.id === terminal.activityId);
  if (!terminal || !activity || !canWake(state, activity)) return none(state);
  const { asleep: _asleep, ...rest } = terminal;
  const woken: Terminal = { ...rest, woken: true };
  const task = activity.kind === 'task' ? taskOfActivity(state, activity.id) : undefined;
  return {
    state: { ...state, terminals: state.terminals.map((t) => (t === terminal ? woken : t)) },
    effects: [{ type: 'spawnTerminal', terminal: woken, activity, ...(task === undefined ? {} : { task }) }],
  };
}

/** Forget: a sleeping terminal goes for good, its scrollback and history with it. A live one is never forgotten. */
export function forgetTerminal(state: State, { terminalId }: Extract<HiveEvent, { type: 'forgetTerminal' }>): Reduced {
  const terminal = state.terminals.find((t) => t.terminalId === terminalId && t.asleep === true);
  if (!terminal) return none(state);
  return { state: { ...state, terminals: state.terminals.filter((t) => t !== terminal) }, effects: [{ type: 'dropTerminalFiles', terminalId }] };
}

// The captured session's place in its activity's record: the task's sessions, free as openSession's (#812), or the workspace's local ones (#590)
function withCapturedSession(state: State, activity: Activity, worker: Worker, sessionId: string, at: string): State | undefined {
  const workers = [...state.workers, worker];
  if (activity.kind === 'local') {
    if (!state.workspaces.includes(activity.workspace)) return undefined;
    const created: Session = { id: sessionId, startedAt: at, stages: [], lastUsedAt: at, agent: SHIM_AGENT };
    return withLocal({ ...state, workers }, activity.workspace, [...localSessionsOf(state, activity.workspace), created]);
  }
  const task = taskOfActivity(state, activity.id);
  return task && touchFreeSession({ ...state, workers }, task, sessionId, at, SHIM_AGENT);
}

/** The shim's register (#696): a free session of the terminal's activity, appended outside the cap like any free session (#459), with the
 * run id and the session id the route drew. Its run lives in the terminal's pty, so nothing spawns. A sleeping or unknown terminal, a command's
 * run or an activity gone: the same state. */
export function captureSession(state: State, { terminalId, runId, sessionId }: Extract<HiveEvent, { type: 'captureSession' }>): Reduced {
  const terminal = liveShell(state, terminalId);
  const activity = terminal && state.activities.find((a) => a.id === terminal.activityId);
  if (!activity) return none(state);
  const startedAt = new Date().toISOString();
  const worker: Worker = { id: randomUUID(), runId, activityId: activity.id, status: 'working', startedAt, lastEvent: { kind: 'manualStart' }, sessionId, freeSession: true, terminalId, agent: SHIM_AGENT };
  return none(withCapturedSession(state, activity, worker, sessionId, startedAt) ?? state);
}
