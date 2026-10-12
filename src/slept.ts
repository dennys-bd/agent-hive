// The runs that sleep (#672): a run that ended with its session kept stays a sleeping tab of its activity, its transcript held by the pty
// host, until the tab closes, the session continues, or it falls out of the last SLEPT_MAX. Pure, as every reducer rule: it reads the state
// before and after an event and returns new objects.
import { activityOfWorker, taskOfWorker } from './activities.js';
import type { Reduced } from './reducer-kit.js';
import { taskId } from './tasks.js';
import { AGENTS, ranAgent } from './agents.js';
import { type Effect, type HiveEvent, type SleepCause, type SleptRun, SLEPT_MAX, type State, type Worker } from './types.js';

const isLiveRun = (state: State, ptyId: string): boolean => state.workers.some((s) => s.runId === ptyId && s.status !== 'empty');

// The session a run holds: its own once SessionStart told it, a stage run's activity's before (as activities.ts's heldId reads it)
const heldSession = (state: State, worker: Worker): string | undefined =>
  worker.sessionId ?? (worker.freeSession ? undefined : activityOfWorker(state, worker)?.sessionId);

// Why the run ended: what the Hive marked on it; else the auto flow, when the Hive killed it in the very reduction that freed it (a stage's
// end, an approval's); else nothing: the user's /exit
function causeOf(worker: Worker, runId: string, effects: Effect[]): SleepCause | undefined {
  if (worker.ending !== undefined) return worker.ending;
  return effects.some((e) => e.type === 'kill' && e.ptyId === runId) ? 'auto' : undefined;
}

// #931: a free run of an agent that picks its own id (Codex), put to sleep by the Hive before its first prompt: it saw no hook and holds no
// session, yet its tab sleeps, and its wake opens a new session of that agent. A /exit or a crash (no cause) leaves nothing, as before
const isFresh = (worker: Worker, sessionId: string | undefined, cause: SleepCause | undefined): boolean =>
  sessionId === undefined && cause !== undefined && worker.freeSession === true && !AGENTS[ranAgent(worker)].canChooseSessionId;

// The record of a run this reduction ended with its session kept: it saw a hook (a run that never opened has no transcript, #587) and held a
// session, or it is a fresh one (#931); and its task, when it has one, is still in the Hive (a closed task takes its runs with it)
function sleptOf(before: State, { state: after, effects }: Reduced, worker: Worker, now: number): SleptRun | undefined {
  const { runId } = worker;
  // #696: a captured run had no tab of its own (its terminal's showed it): it records no sleeping tab
  if (runId === undefined || worker.status === 'empty' || worker.forgotten || worker.terminalId !== undefined || isLiveRun(after, runId)) return undefined;
  const sessionId = heldSession(before, worker);
  const cause = causeOf(worker, runId, effects);
  const isKept = (worker.seenAt !== undefined && sessionId !== undefined) || isFresh(worker, sessionId, cause);
  const task = taskOfWorker(before, worker);
  if (!isKept || (task !== undefined && !after.tasks.some((c) => taskId(c) === taskId(task)))) return undefined;
  const activity = activityOfWorker(before, worker);
  return {
    ptyId: runId, agent: ranAgent(worker), kind: worker.freeSession ? 'session' : 'stage', at: now,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(task === undefined ? {} : { taskId: taskId(task) }),
    ...(task !== undefined && !worker.freeSession ? { stage: task.stage } : {}),
    ...(activity?.kind === 'local' ? { workspace: activity.workspace } : {}),
    ...(cause === undefined ? {} : { cause }),
  };
}

// The sessions this reduction continues in a new run: a continued session's spawn, or a stage run that resumes its activity's session
function resumed(effects: Effect[]): Set<string> {
  return new Set(effects.flatMap((e) => {
    if (e.type === 'spawnSession') return e.continues && e.sessionId !== undefined ? [e.sessionId] : [];
    if (e.type === 'spawn' && e.session === 'continue' && e.activity.sessionId !== undefined) return [e.activity.sessionId];
    return [];
  }));
}

const forget = (ptyIds: readonly string[]): Effect[] => ptyIds.map((ptyId): Effect => ({ type: 'forgetScrollback', ptyId }));

// The runs this reduction ended: live before, not after. One it records nothing for must not leave its transcript in the pty host, where it
// would take a SLEPT_MAX slot from a real sleeping run
const endedRuns = (before: State, after: State): string[] =>
  before.workers.flatMap((w) => (w.runId !== undefined && w.status !== 'empty' && !isLiveRun(after, w.runId) ? [w.runId] : []));

// A record whose task left the Hive or whose workspace left the Comb has no tab to sleep in
const stillHeld = (state: State, s: SleptRun): boolean =>
  (s.taskId === undefined || state.tasks.some((c) => taskId(c) === s.taskId)) && (s.workspace === undefined || state.workspaces.includes(s.workspace));

/** A forgetSlept for a run still live (#672): its tab closed while the stop it sent was on its way, so its exit, still to come, records nothing.
 * Only a run already ending: a stray forget for a working run must not cost its session the sleeping record its later exit earns. */
const isEnding = (w: State['workers'][number], ptyId: string): boolean => w.runId === ptyId && w.status !== 'empty' && w.ending !== undefined;
export const markForgotten = (state: State, ptyId: string): State =>
  state.workers.some((w) => isEnding(w, ptyId))
    ? { ...state, workers: state.workers.map((w) => (isEnding(w, ptyId) ? { ...w, forgotten: true } : w)) }
    : state;

/** The sleeping runs after `event` (#672): the runs it ended with their session kept are appended, newest last; the records of the sessions it
 * continues, the one forgetSlept names and those of a task or workspace gone go, and past SLEPT_MAX the oldest go. Every record that goes
 * forgets its transcript, as does every run that ended unrecorded, and forgetSlept always does, since its run may not have exited yet. A
 * boot drops every transcript with the Hive that held it; a failed spawn never showed a session. */
export function withSlept(before: State, event: HiveEvent, reduced: Reduced, now: number): Reduced {
  if (event.type === 'boot') return reduced;
  const after = reduced.state;
  const added = event.type === 'spawnFailed' ? [] : before.workers.flatMap((worker) => sleptOf(before, reduced, worker, now) ?? []);
  const woken = resumed(reduced.effects);
  const named = event.type === 'forgetSlept' ? [event.ptyId] : [];
  const all = [...(after.slept ?? []), ...added];
  const kept = all.filter((s) => (s.sessionId === undefined || !woken.has(s.sessionId)) && !named.includes(s.ptyId) && stillHeld(after, s));
  const slept = kept.slice(Math.max(0, kept.length - SLEPT_MAX));
  const held = new Set(slept.map((s) => s.ptyId));
  const gone = [...all.map((s) => s.ptyId), ...named, ...endedRuns(before, after)].filter((id) => !held.has(id));
  if (added.length === 0 && gone.length === 0) return reduced;
  return { state: { ...after, slept }, effects: [...reduced.effects, ...forget([...new Set(gone)])] };
}
