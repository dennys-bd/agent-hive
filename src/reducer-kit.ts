import { randomUUID } from 'node:crypto';
import { activityOf, resultOf, taskOfWorker, withActivity } from './activities.js';
import { sessionBaseline, touchSession, withRun, withStageRun } from './record-kit.js';
import { handoverRun } from './task-runs.js';
import { withColumnWrite } from './column-write.js';
import { taskId, closeWait, isGate, onSource, resolveWorkspace, runningFirst, slugFor, slugOwner, slugTakenMessage, stageOf } from './tasks.js';
import { isLeaving } from './types.js';
import { stageWorkerCount, workerCount } from './worker-count.js';
import type { Activity, ActivityRecord, SourceAction, Task, Stage, Effect, SessionPolicy, Worker, WorkerEventKind, SpawnRun, State, Status } from './types.js';

// The reducer's building blocks, shared by orchestrator.ts and runs.ts (#283): orchestrator.ts was over 800 lines, and the rules this issue adds
// live in runs.ts. Every function here is pure and returns new objects.

export { stageWorkerCount, workerCount } from './worker-count.js';

export interface Reduced {
  state: State;
  effects: Effect[];
}

/** A free worker for the gate and for a manual start: empty and not draining. */
export function isFree(worker: Worker): boolean {
  return worker.status === 'empty' && !worker.draining;
}

/** A free worker for a run started by hand, else one appended over the cap that drains with its run (#116): what start, resume and restart
 * share (#283). A free session appends a worker of its own instead (#459). */
export function takeWorker(state: State): { state: State; index: number } {
  const free = state.workers.findIndex(isFree);
  if (free >= 0) return { state, index: free };
  return { state: { ...state, workers: [...state.workers, { ...emptyWorker(), draining: true }] }, index: state.workers.length };
}

/** Every live run, the user's sessions too: what shutdown when done waits for (#233). */
export const occupiedCount = (workers: Worker[]): number => workers.filter((s) => s.status !== 'empty').length;

/** A free worker that is not draining and room under the cap when there is one: what both gates need past the signal. */
export const hasRoom = (workers: Worker[], limit?: number): boolean => workers.some(isFree) && (limit === undefined || workerCount(workers) < limit);

/** Room under the stage's cap (#475): no key in `caps` is no cap. */
export const stageHasRoom = (state: State, stage: string, caps: Record<string, number>): boolean =>
  !Object.hasOwn(caps, stage) || stageWorkerCount(state, stage) < caps[stage];

export function emptyWorker(): Worker {
  return { id: randomUUID(), status: 'empty' };
}

export function none(state: State): Reduced {
  return { state, effects: [] };
}

export function patch(state: State, ptyId: string, changes: Partial<Worker>): Reduced {
  return none({ ...state, workers: state.workers.map((s) => (s.runId === ptyId ? patchedWorker(s, changes) : s)) });
}

// A hold for approval (#268) waits for the user as `waiting` does: its time counts as waiting (#248).
const WAITS: readonly Status[] = ['waiting', 'approval'];

// waitingSince follows the status (#233): stamped when the worker enters a wait, kept while it stays in one (a Notification after the idle
// Stop is the same wait), dropped by any other status. A change with no status leaves it alone; leaving a wait adds it to waitedMs (#248).
export function patchedWorker(worker: Worker, changes: Partial<Worker>): Worker {
  const merged = { ...worker, ...changes };
  if (changes.status === undefined) return merged;
  const { waitingSince: _waitingSince, ...rest } = merged;
  if (!WAITS.includes(changes.status)) return { ...rest, ...closeWait(worker, Date.now()) };
  return { ...rest, waitingSince: WAITS.includes(worker.status) && worker.waitingSince !== undefined ? worker.waitingSince : new Date().toISOString() };
}

export const withTask = (state: State, task: Task): State => ({ ...state, tasks: state.tasks.map((c) => (taskId(c) === taskId(task) ? task : c)) });

/** The task's stage run let go of its activity (#629): the activity's workerId dropped. */
export function dropWorker(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  if (live?.workerId === undefined) return state;
  const { workerId: _workerId, ...rest } = live;
  return withActivity(state, rest);
}

// A draining worker and a session's own worker (#459) leave with their run: neither is one the fill may take; any other worker empties for it.
export const releaseWorker = (workers: Worker[], worker: Worker): Worker[] =>
  (worker.draining || worker.freeSession ? workers.filter((s) => s.id !== worker.id) : workers.map((s) => (s.id === worker.id ? { id: s.id, status: 'empty' as Status } : s)));

// The run's time joins its task as the worker frees (#248); a task that is gone (closed, past the last stage) takes nothing.
export function releaseRun(state: State, worker: Worker, end: number): State {
  const task = taskOfWorker(state, worker);
  return task ? withRun(state, task, worker, end) : state;
}

/** A stage run that ended without its stage's end, by Stop or on its own (#283): out of the fill until a start, a continue or a restart, or until
 * the task changes stage; the fill never picks a stopped task. Here and not in runs.ts so stage-commands.ts shares it (#755). */
export const stoppedWork = (activity: Activity): Activity => ({ ...activity, stopped: true, stoppedAt: new Date().toISOString() }); // #580: when, for the status box

// Whether the source still has the task: a kept orphan, a missing task and a local one (#132) are never written, by a move or an action (#286).
const onTheSource = (task: Task): boolean => !task.orphan && !task.missing && !task.created;

// Whether the source must be told: a target that differs from what the source shows, for a task the source still has.
export const shouldWrite = (task: Task, target: string | undefined): target is string =>
  target !== undefined && target !== task.boardColumn && onTheSource(task);

interface Written {
  task: Task;
  effects: Effect[];
}

// #515: one source's action list, in its order. A move is written when the source does not show it yet (the column follows along, so a later
// move compares with it, and the task carries the write's mark until a poll shows it, #889); any other action is emitted for a task the source
// still has, and a leaving one marks the task leaving (#286).
// A failed action does not stop the list: every effect is already emitted, so with [move Done, archive] a refused archive leaves the source
// on Done while the task keeps its stage, carrying the error.
export function sourceWrites(task: Task, actions: readonly SourceAction[] | undefined): Written {
  const id = taskId(task);
  const now = new Date().toISOString(); // #889: when this list's writes go out, what a stale poll's window counts from
  return (actions ?? []).reduce<Written>((acc, action) => {
    if (action.type === 'move') {
      if (!shouldWrite(acc.task, action.column)) return acc;
      return { task: withColumnWrite(acc.task, action.column, now), effects: [...acc.effects, { type: 'setColumn', itemId: id, column: action.column }] };
    }
    if (!onTheSource(acc.task)) return acc;
    const next: Task = isLeaving(action) ? { ...acc.task, leaving: true } : acc.task;
    return { task: next, effects: [...acc.effects, { type: 'sourceAction', itemId: id, taskId: id, action }] };
  }, { task, effects: [] });
}

// What {result.<path>} renders in the effect's prompt (#99, #629): the task's records merged at the reduction, absent while none has a result
function resultField(state: State, task: Task): { result?: Record<string, unknown> } {
  const result = resultOf(state, taskId(task));
  return result === undefined ? {} : { result };
}

// Runs `task` in `workers[index]`: the session policy is resolved here (continue needs an id to resume; without one the run is new,
// with an id the Hive generates so it never waits for the hook), the task's source's onStart list is written in order (#515), then the spawn.
// The worker keeps its draining mark: a free worker never has one, so fill is as today; the worker a start opens over the cap keeps it (#116).
// Every start, by hand or through fill, then puts the stage's running tasks on top with this one last among them (#117): the source is not told.
// Every stage run drops the stopped mark (#283): the fill never picks a stopped task, so only a start by hand gets here with one.
// A resume passes its own policy (#283): continue, whatever the stage says. A transition's handover (#134) names the session and the prompt,
// from the fill, a start or Continue alike.
export function occupy(state: State, index: number, queued: Task, stage: Stage, kind: WorkerEventKind, run: SpawnRun = 'stage', policy?: SessionPolicy): Reduced {
  const born = ensureActivity(state, queued);
  if (!born) return none(state); // the fill and a start only pass a task that resolves to a workspace
  const answer = handoverRun(born.activity); // #134: a transition's handover decides the session and the prompt, whoever started the run
  const work = answer?.activity ?? born.activity;
  const task = queued;
  const startedAt = new Date().toISOString();
  const session = answer?.policy ?? policy ?? (stage.session === 'continue' && work.sessionId !== undefined ? 'continue' : 'new');
  // A new run is a new Claude session, a continue the activity's own (#164); either way the session records this stage and this use (#236)
  const sessionId = session === 'new' ? randomUUID() : work.sessionId;
  const worker: Worker = {
    id: born.state.workers[index].id, runId: randomUUID(), activityId: born.activity.id, status: 'working', startedAt, lastEvent: { kind }, done: undefined,
    ...sessionBaseline(born.state, task, sessionId), // a resumed transcript already holds its old turns (#248)
    ...(born.state.workers[index].draining ? { draining: true } : {}),
  };
  const written = sourceWrites(task, onSource(stage.onStart, task.item.source)); // the task's own source only (#180)
  const workspace = resolveWorkspace(task, born.state.workspaces, born.state.sourceWorkspaces); // frozen from the first spawn on (#179): a later hint no longer moves the task
  const started: Task = { ...written.task, ...(workspace === undefined ? {} : { workspace }) };
  // #812: a stage run starts: the stage's sessions are a stage run's again, so continue may be offered once it stops
  const { stopped: _stopped, stoppedAt: _stoppedAt, sessionId: _was, freeSessionStage: _free, ...unstopped } = work;
  const running: Activity = { ...unstopped, workerId: worker.id, ...(sessionId === undefined ? {} : { sessionId }) };
  // the activity holds its worker before the stage is reordered
  const next = withActivity(withTask({ ...born.state, workers: born.state.workers.map((s, i) => (i === index ? worker : s)) }, started), running);
  const touched = withStageRun(sessionId === undefined ? next : touchSession(next, started, sessionId, stage.name, startedAt), started, stage.name); // #742: the run's attempt
  const activity = activityOf(touched, taskId(started)) ?? born.activity; // as stored after the writes above (#629)
  const spawn: Effect = {
    type: 'spawn', worker, activity, task: started, stage, session, run: answer?.run ?? run, ...resultField(touched, started), ...(answer ? { prompt: answer.prompt } : {}),
  };
  return {
    state: { ...touched, tasks: runningFirst(touched.tasks, taskId(started), touched) }, // `touched` already holds the new worker
    effects: [...written.effects, spawn],
  };
}

/** The task's live activity, born with its record when the task has none (#629): a stage spawn, a manual start, a first open, a session or a
 * terminal goes through it, so a second run finds the first one's. The id is drawn here, as the worker and run ids are. Undefined when the
 * task resolves to no workspace, which every caller already refused. */
export function ensureActivity(state: State, task: Task): { state: State; activity: Activity } | undefined {
  const live = activityOf(state, taskId(task));
  if (live) return { state, activity: live };
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces);
  if (workspace === undefined) return undefined;
  const id = randomUUID();
  const slug = slugFor(task.item);
  const activity: Activity = { id, kind: 'task', workspace, slug };
  const record: ActivityRecord = { id, taskIds: [taskId(task)], slug, sessions: [] };
  return { state: { ...state, activities: [...state.activities, activity], activityRecords: [...state.activityRecords, record] }, activity };
}

// An answer to a git run is honoured only for the activity that carries `deleting`: only startDeleteActivity, deletingActivity, deletingTask and restarting set it,
// on a stopped task, and the answer drops it, so a second answer (or one for an activity gone meanwhile) changes nothing.
export const beingDeleted = (state: State, activityId: string): Activity | undefined => state.activities.find((a) => a.id === activityId && a.deleting);

// The task's live activity while it carries `deleting`: what the routes' answers, by task id until the routes move under /activities (#629), act on.
export const deletingOf = (state: State, itemId: string): Activity | undefined => {
  const live = activityOf(state, itemId);
  return live?.deleting ? live : undefined;
};

export const unmarked = (state: State, { deleting: _deleting, ...activity }: Activity): State => withActivity(state, activity);

/** Delete activity (#629): the task's live activity goes, its record stays for the task to read and copy from. */
export function dropActivity(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  return live ? { ...state, activities: state.activities.filter((a) => a !== live) } : state;
}

/** A delete (#629): what main's forget kept on the task goes on a fresh empty activity, everything but the run fields the delete removed or that
 * never outlive their run, so a gate task still awaits approval, a stopped one stays out of the fill and the next spawn keeps local and base.
 * Nothing kept, no activity. */
export function keptMarks(state: State, task: Task, activity: Activity): State {
  const { id: _id, kind: _kind, workspace: _workspace, slug: _slug, worktree: _worktree, branch: _branch, worktreeGone: _gone, sessionId: _sessionId,
    deleting: _deleting, setup: _setup, workerId: _workerId, freeSessionStage: _free, checkpoints: _checkpoints, ...kept } = activity; // #812: a free run's mark is its worktree's visit; #619: the checkpoints go with the delete, as their refs do
  if (Object.keys(kept).length === 0) return state;
  const born = ensureActivity(state, task);
  return born ? withActivity(born.state, { ...born.activity, ...kept }) : state;
}

// The task with the slug refusal (#180) when another task of its workspace owns its slug: the task and the bar carry the reason, and the task
// leaves the fill until a manual start (which meets the same check). Undefined when the start may go on.
export function slugTaken(state: State, task: Task): State | undefined {
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces);
  const owner = workspace === undefined ? undefined : slugOwner(state, task, workspace);
  if (!owner) return undefined;
  const message = slugTakenMessage(activityOf(state, taskId(task))?.slug ?? slugFor(task.item), owner);
  return { ...withError(state, task, message), error: message };
}

/** A failure the task waits on (#58, #180, #286, #629): on its live activity, born for it when it has none, out of the fill until a manual
 * start clears it. A task that resolves to no workspace has no activity to hold it; the caller's bar line still shows it. */
export function withError(state: State, task: Task, message: string): State {
  const born = ensureActivity(state, task);
  return born ? withActivity(born.state, { ...born.activity, error: message }) : state;
}

/** A manual start's retry (#58, #629): the task's live activity drops its last failure. */
export function clearedError(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  if (live?.error === undefined) return state;
  const { error: _error, ...rest } = live;
  return withActivity(state, rest);
}

// A task that just entered its stage (#268, #283, #315, #629): its live activity drops the stopped mark, a free run's mark (#812: it belongs to
// the visit it was made in), an awaited approval, a queued
// handover (#134: transit.ts writes the new one after the entry) and a handoff being written (#692), which belong to the stage left behind; in a manual gate it awaits approval from its entry, its activity born for it when it has
// none, since approve acts on an activity. A gate task that resolves to no workspace gets none.
function enteredStage(state: State, task: Task): State {
  const gate = isGate(stageOf(state.stages, task.stage));
  const live = activityOf(state, taskId(task));
  const born = live ? { state, activity: live } : gate ? ensureActivity(state, task) : undefined;
  if (!born) return state;
  const { stopped: _stopped, stoppedAt: _stoppedAt, approval: _approval, handover: _handover, handoffPending: _handoffPending, handoffFeedback: _handoffFeedback, freeSessionStage: _free,
    stageStart: _start, ...rest } = born.activity; // #812: each visit records its own start, which recordStart then keeps for the visit
  return withActivity(born.state, gate ? { ...rest, approval: { since: task.enteredAt ?? new Date().toISOString() } } : rest);
}

/** Every task of `state` that entered a stage since `before` (a new one, or one whose stage or entry changed; an entry only stamped on a task
 * that had none is no entry) as enteredStage leaves it (#629). poll, setStages, moveToStage, createTask and a transition (transit.ts) run it right after `enter`,
 * before any fill reads the activity. */
export function settleEntries(before: Task[], state: State): State {
  const was = new Map(before.map((t) => [taskId(t), t]));
  return state.tasks.reduce((acc, task) => {
    const old = was.get(taskId(task));
    const same = old !== undefined && old.stage === task.stage && (old.enteredAt === task.enteredAt || old.enteredAt === undefined);
    return same ? acc : enteredStage(acc, task);
  }, state);
}

// The worker an event from a worker applies to: an unknown worker or an empty worker is nobody (any local process can reach the routes).
export function liveWorker(state: State, ptyId: string): Worker | undefined {
  const worker = state.workers.find((s) => s.runId === ptyId);
  return worker && worker.status !== 'empty' ? worker : undefined;
}

// Same process, same worker, same ptyId: the Stop is answered with the destination's prompt, or `prompt` (#134: a handover's, a handoff
// request). The transition's sources are written first, then the destination's onStart list against the column as just updated, so the source
// sees every write in order (#515); on the task's own stage (sameStage: feedback, a handoff) its start already ran, so only a move the source
// does not show is written again. The handover the move queued is answered here, so it leaves the activity.
export function continueInPlace(freed: State, worker: Worker, ptyId: string, moved: Task, next: Stage, finished: Effect[], prompt?: string, sameStage = false): Reduced {
  const onStart = onSource(next.onStart, moved.item.source);
  const written = sourceWrites(moved, sameStage ? onStart?.filter((a) => a.type === 'move') : onStart);
  const { waitingSince: _waitingSince, ...running } = worker; // it leaves waiting outside patch (#233)
  const kept: Worker = { ...running, ...closeWait(worker, Date.now()), status: 'working', done: undefined, verdict: undefined, question: undefined, lastEvent: { kind: 'continuing' } };
  const task = written.task;
  const held = withTask({ ...freed, workers: freed.workers.map((s) => (s.id === worker.id ? kept : s)) }, task);
  const live = activityOf(freed, taskId(task));
  if (!live) return { state: held, effects: [...finished, ...written.effects] }; // a running worker always has its activity (#629)
  const { handover: _handover, ...unqueued } = live;
  const placed = withActivity(held, { ...unqueued, workerId: worker.id });
  const touched = withStageRun(live.sessionId === undefined ? placed : touchSession(placed, task, live.sessionId, next.name, new Date().toISOString()), task, next.name); // one stage more (#236); the run's attempt (#742)
  const activity = activityOf(touched, taskId(task)) ?? live;
  return {
    state: touched,
    effects: [
      ...finished, ...written.effects,
      { type: 'continue', ptyId, activity, task, stage: next, ...resultField(touched, task), ...(prompt === undefined ? {} : { prompt }) },
    ],
  };
}
