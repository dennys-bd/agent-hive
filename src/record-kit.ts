import { activityOf, recordOf, recordsOf, recordWithSession, usageOf, withActivity, withRecord } from './activities.js';
import { NO_USAGE, runTime, sessionsOf, taskId, titled, workersOf } from './tasks.js';
import { recordedIssues } from './decomposition.js';
import type { ActivityRecord, AgentId, DeleteActivityScope, PrSlice, Session, State, Task, TaskUsage, Worker } from './types.js';

// The record side of a task's runs (#629): its sessions, its usage, its result and its PRs, written to the records where tasks.ts wrote them
// on the task. New work lands in the live activity's record; a session already listed is updated in the record that holds it. Pure.

/** The live activity's record: where a task's new work lands. */
export function liveRecord(state: Pick<State, 'activities' | 'activityRecords'>, task: Task): ActivityRecord | undefined {
  const live = activityOf(state, taskId(task));
  return live && recordOf(state, live.id);
}

const withLive = (state: State, task: Task, change: (record: ActivityRecord) => ActivityRecord): State => {
  const record = liveRecord(state, task);
  return record ? withRecord(state, change(record)) : state;
};

const withSession = (state: State, task: Task, id: string, change: (session: Session) => Session): State => {
  const holder = recordWithSession(state, taskId(task), id);
  return holder ? withRecord(state, { ...holder, sessions: holder.sessions.map((s) => (s.id === id ? change(s) : s)) }) : state;
};

/** Session `id` put to work by a stage run in `stage` at `now` (#236): used again in the record holding it (the stage added unless it is already its last
 * one, a resume in the same stage, keeping its own agent), else appended to the live record, started now; a new one records `agent` (#925). */
export function touchSession(state: State, task: Task, id: string, stage: string, now: string, agent: AgentId): State {
  if (recordWithSession(state, taskId(task), id)) {
    return withSession(state, task, id, (s) => ({ ...s, stages: s.stages.at(-1) === stage ? s.stages : [...s.stages, stage], lastUsedAt: now }));
  }
  return withLive(state, task, (r) => ({ ...r, sessions: [...r.sessions, { id, startedAt: now, stages: [stage], lastUsedAt: now, agent }] }));
}

/** Session `id` put to work by a free run at `now` (#812): a free session, a copy or a captured one has no stage prompt to go on with, so it
 * never writes `stages`, the one thing stageSession reads. One the record holds (a free one, or a stage run's resumed by hand) only moves its
 * lastUsedAt; a new one is appended to the live record, free and with no stage. It marks the stage on the live activity, so the task offers no
 * continue there until a stage run spawns. A new one records `agent` (#925); one already listed keeps its own. */
export function touchFreeSession(state: State, task: Task, id: string, now: string, agent: AgentId): State {
  const used = recordWithSession(state, taskId(task), id)
    ? withSession(state, task, id, (s) => ({ ...s, lastUsedAt: now }))
    : withLive(state, task, (r) => ({ ...r, sessions: [...r.sessions, { id, startedAt: now, stages: [], lastUsedAt: now, free: true, agent }] }));
  return markFreeRun(used, task);
}

/** The free run's mark on the live activity (#812): the task offers no continue on its stage until a stage run spawns. A Codex open sets it
 * alone; its session is recorded at its first SessionStart (#931). */
export function markFreeRun(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  return live ? withActivity(state, { ...live, freeSessionStage: task.stage }) : state;
}

const addRun = (usage: TaskUsage, run: Pick<TaskUsage, 'ms' | 'waitingMs'>): TaskUsage =>
  ({ ...usage, ms: usage.ms + run.ms, waitingMs: usage.waitingMs + run.waitingMs });

/** One turn counted (#248, #489): the delta joins the live record's usage, as it joins the budget; the transcript total becomes the baseline
 * of the session it ran in, and a title the turn read names it, in the record holding it. Claude Code has no way to clear a name. */
export function withTurn(state: State, task: Task, sessionId: string | undefined, total: number, delta: number, title?: string): State {
  const counted = withLive(state, task, (r) => ({ ...r, usage: { ...(r.usage ?? NO_USAGE), tokens: (r.usage ?? NO_USAGE).tokens + delta } }));
  return sessionId === undefined ? counted : withSession(counted, task, sessionId, (s) => ({ ...titled(s, title), tokens: total }));
}

/** A run's time folded into the live record up to `end` (#248): what the reducer stores when the worker frees. */
export const withRun = (state: State, task: Task, worker: Worker, end: number): State =>
  withLive(state, task, (r) => ({ ...r, usage: addRun(r.usage ?? NO_USAGE, runTime(worker, end)) }));

/** Where a worker running session `id` measures its first delta from (#248): the last total seen for it, in any record of the task. A resumed
 * transcript already holds the old turns, so starting from empty would count them again. A new session is listed nowhere: `{}`. */
export function sessionBaseline(state: Pick<State, 'activityRecords'>, task: Task, id: string | undefined): Pick<Worker, 'tokens'> {
  const tokens = id === undefined ? undefined : sessionsOf(state, taskId(task)).find((s) => s.id === id)?.tokens;
  return tokens === undefined ? {} : { tokens };
}

/** A task's totals right now (#248): every record's usage plus, for every worker running on it, the time so far. Tokens are stored at every
 * Stop, so they need no running share. The detail panel re-renders on the main window's tick, so the time moves without a state write. */
export function taskTotals(state: Pick<State, 'workers' | 'activities' | 'activityRecords'>, task: Task, now: number): TaskUsage {
  return workersOf(state, task).reduce((total, worker) => addRun(total, runTime(worker, now)), usageOf(state, taskId(task)) ?? NO_USAGE);
}

/** hive_done's result shallow-merged into the live record, a newer key winning (#99). */
export const withResult = (state: State, task: Task, result: Record<string, unknown>): State =>
  withLive(state, task, (r) => ({ ...r, result: { ...r.result, ...result } }));

/** One step of a decomposition's write (#865): `id` → the issue `number`, merged into the live record's result.decompositionIssues. */
export const withDecompositionIssue = (state: State, task: Task, id: string, number: number): State =>
  withLive(state, task, (r) => ({ ...r, result: { ...r.result, decompositionIssues: { ...recordedIssues(r.result), [id]: number } } }));

/** A PR appended once to the live record, open (#207): both hive_pr and the gh pr create detection may report it. A url reported again takes
 * hive_pr's slice, which the detection never has (#698); without one the record is the same object. The reporting session is written only
 * with a new url (#62): the session that opened the PR is the first to say so, and a later report never overwrites it. */
export const withPr = (state: State, task: Task, url: string, slice?: PrSlice, sessionId?: string): State =>
  withLive(state, task, (r) => {
    if (!r.prs?.some((pr) => pr.url === url)) return { ...r, prs: [...(r.prs ?? []), { url, state: 'open' as const, ...(slice ? { slice } : {}), ...(sessionId ? { sessionId } : {}) }] };
    return slice === undefined ? r : { ...r, prs: r.prs.map((pr) => (pr.url === url ? { ...pr, slice } : pr)) };
  });

/** Delete activity's record side (#208, #236, #629): every session of every record of the task moves to the main repo, or goes under
 * scope.session, as main's forget walked every session of the task. */
export const keepRecord = (state: State, task: Task, scope: DeleteActivityScope): State =>
  recordsOf(state, taskId(task)).reduce((acc, r) => withRecord(acc, { ...r, sessions: scope.session ? [] : r.sessions.map((s): Session => ({ ...s, repo: true })) }), state);

/** A session forgotten (#304), from the record holding it. */
export function withoutSession(state: State, task: Task, sessionId: string): State {
  const holder = recordWithSession(state, taskId(task), sessionId);
  return holder ? withRecord(state, { ...holder, sessions: holder.sessions.filter((s) => s.id !== sessionId) }) : state;
}

/** A spawn that never started (#283): the session its `new` run appended is forgotten, so the stage reads as not run and the task offers Start
 * again instead of a Continue on a transcript that never existed. A resumed session's entry is older and stays. The activity's sessionId falls
 * back to the last session left, as it was before the spawn. A claude session that never opened passes its own id: only its entry goes. */
export function forgetFailedSession(state: State, task: Task, worker: Worker, id = activityOf(state, taskId(task))?.sessionId): State {
  const holder = id === undefined ? undefined : recordWithSession(state, taskId(task), id);
  const failed = holder?.sessions.find((s) => s.id === id && s.startedAt === worker.startedAt);
  if (!holder || !failed) return state;
  const forgotten = withRecord(state, { ...holder, sessions: holder.sessions.filter((s) => s !== failed) });
  const live = activityOf(forgotten, taskId(task));
  if (!live || id !== live.sessionId) return forgotten; // a free session's own id (#283): the activity's sessionId is the stage run's
  const { sessionId: _sessionId, ...rest } = live;
  const previous = sessionsOf(forgotten, taskId(task)).at(-1)?.id;
  return withActivity(forgotten, { ...rest, ...(previous === undefined ? {} : { sessionId: previous }) });
}

// Whether a free run other than `worker` happened in the task's current visit (#812): another free session used since the entry (a task with no
// entry time counts any), or another free run still open. The failed run's own session is never one: its open moved its lastUsedAt
function otherFreeRun(state: State, task: Task, worker: Worker): boolean {
  const used = sessionsOf(state, taskId(task)).some((s) => s.free && s.id !== worker.sessionId && (task.enteredAt === undefined || s.lastUsedAt >= task.enteredAt));
  return used || workersOf(state, task).some((w) => w.id !== worker.id && w.freeSession && w.status !== 'empty');
}

/** A free run that never opened (#812), as forgetFailedSession: its entry goes, and unless another free run happened in this visit, the free
 * run's mark too, so a stage no free run touched keeps its continue. */
export function forgetFailedFreeRun(state: State, task: Task, worker: Worker): State {
  // a run that never learned its id (#931) has no entry to drop: never let the default read the stage run's id
  const forgotten = worker.sessionId === undefined ? state : forgetFailedSession(state, task, worker, worker.sessionId);
  const live = activityOf(forgotten, taskId(task));
  if (live?.freeSessionStage === undefined || otherFreeRun(forgotten, task, worker)) return forgotten;
  const { freeSessionStage: _free, ...rest } = live;
  return withActivity(forgotten, rest);
}

/** One more stage run of `stage` on the task, in its live record (#742): a spawn, a restart, a continue and a feedback run each count, so the
 * count survives a restart and events.jsonl's attempt reads it from the reduced state. */
export const withStageRun = (state: State, task: Task, stage: string): State =>
  withLive(state, task, (r) => ({ ...r, stageRuns: { ...r.stageRuns, [stage]: (r.stageRuns?.[stage] ?? 0) + 1 } }));
