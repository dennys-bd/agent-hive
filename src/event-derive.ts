import { apiErrorOf, decideStopFailure } from './api-errors.js';
import { activityOf, activityOfWorker, recordOf, taskOfActivity, taskOfWorker } from './activities.js';
import { textRef, type Correlation, type FinishVia, type GoneReason, type MoveBy, type RecordInput, type RunKind, type StageOutcome } from './events.js';
import type { StageRunEnd } from './human-signals.js';
import { effectiveLimits } from './orchestrator.js';
import { prNumber } from './pull-requests.js';
import { spawnFailureCode } from './spawn-failure.js';
import { workerCount } from './reducer-kit.js';
import { onSource, runTime, stageOf, taskId } from './tasks.js';
import { outgoing } from './transitions.js';
import { END, isLeaving, type EffectiveLimits, type SourceAction, type HiveEvent, type Signal, type State, type Task, type TaskPr, type Worker } from './types.js';
import { rulePercents } from './usage-rules.js';

// The facts of one reduction for events.jsonl (#742), derived from the two states and the event as describeChanges derives hive.log's lines:
// one place covers every reducer rule, current or future, and the reducer stays pure. Pure: `now` is the caller's clock.

/** A stage run this reduction started, with the pty it runs in: what the server's tracker opens (#742). */
export interface StartedRun { ptyId: string; correlation: Correlation; waitedMs: number }

const iso = (ms: number): string => new Date(ms).toISOString();

/** Milliseconds from an ISO time to `now` (#742); 0 for one that is missing or does not parse. */
export function since(at: string | undefined, now: number): number {
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) ? Math.max(0, now - ms) : 0;
}

// A field that does not apply is absent, never undefined
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const occupied = (worker: Worker): boolean => worker.runId !== undefined && worker.status !== 'empty';

/** A task's visible id as a record's `task` (#742). A visible id can name a client (a Jira key like ACME-123): fine in this local file, but it
 * must be reconsidered before any report or telemetry built on events.jsonl leaves the machine. */
export const visibleId = (task: Task | undefined): { task?: string } => (task === undefined ? {} : { task: task.item.id });

/** The ids that join a record to the rest (#742): the task, its activity, its stage with the attempt there, and the session. Whatever the
 * state no longer holds is left out; a free session runs no stage, so it has neither stage nor attempt, nor the stage run's session. */
export function correlationOf(state: State, worker?: Worker, given?: Task): Correlation {
  const task = given ?? (worker ? taskOfWorker(state, worker) : undefined);
  const activity = worker ? activityOfWorker(state, worker) : task && activityOf(state, taskId(task));
  const free = worker?.freeSession === true;
  const stage = free ? undefined : task?.stage;
  const attempt = stage === undefined || activity === undefined ? undefined : recordOf(state, activity.id)?.stageRuns?.[stage];
  const session = worker?.sessionId ?? (free ? undefined : activity?.sessionId);
  return compact({ task_id: task && taskId(task), ...visibleId(task), activity_id: activity?.id, stage, session_id: session, attempt });
}

/** The ids of the task that holds a PR (#742): what pr.checks and pr.commits join by; none for a link no record holds any more. */
export function prCorrelation(state: State, url: string): Correlation {
  const record = state.activityRecords.find((r) => r.prs?.some((pr) => pr.url === url));
  const task = record && taskOfActivity(state, record.id);
  return task ? correlationOf(state, undefined, task) : {};
}

// Who moved a task: by hand, an approval, a merge (reserved), a delete-activity stage's action ending, the source poll (its column changed
// in the source); any other event is the flow itself (hive_done and its Stop)
const MOVED_BY: Partial<Record<HiveEvent['type'], MoveBy>> = {
  moveToStage: 'hand', approve: 'approval', prStates: 'merge', activityDeleted: 'on_finish', activityRemoved: 'on_finish', stageCommandEnded: 'on_finish', ciRead: 'on_finish', poll: 'source', // #755: a passed commands stage; #834: a passed wait
  stageCommandsRefused: 'on_finish', ciFailed: 'on_finish', ciClock: 'on_finish', // #134: a routed failure moves the task
};
const BY_HAND: readonly HiveEvent['type'][] = ['closeTask', 'closeMissing', 'taskDeleted'];

// The mechanism that took a finished task out (#134: a transition's sources): a leaving action's type once the source confirmed it, else a move
// written by a transition to end; none for a task no source action applies to (a local one, or no move)
function finishVia(state: State, task: Task): FinishVia {
  const leaving = outgoing(state.transitions, task.stage);
  const actions = (ends: boolean): SourceAction[] => leaving.filter((t) => !ends || t.to === END).flatMap((t) => onSource(t.sources, task.item.source) ?? []);
  if (task.leaving) {
    const type = actions(false).find(isLeaving)?.type;
    return type === 'archive' || type === 'remove' || type === 'delete' ? type : 'none';
  }
  return !task.created && actions(true).some((a) => a.type === 'move') ? 'move' : 'none';
}

// Why a task left: missing from the source, closed or deleted by hand with no leaving action in flight, else finished with its mechanism
function goneFields(state: State, task: Task, event: HiveEvent): { reason: GoneReason; via?: FinishVia } {
  if (task.missing) return { reason: 'missing' };
  if (!task.leaving && BY_HAND.includes(event.type)) return { reason: 'hand' };
  return { reason: 'finished', via: finishVia(state, task) };
}

// Issue to merge: the source's own creation time; a task created in the Hive was created now
function createdAt(task: Task, now: number): { source_created_at?: string } {
  if (task.item.createdAt !== undefined) return { source_created_at: task.item.createdAt };
  return task.created ? { source_created_at: iso(now) } : {};
}

// A task that appeared, moved or left. A rename of sources swaps every id and a rename of stages every stage name, which is neither (#278, #861)
function taskRecords(prev: State, next: State, event: HiveEvent, now: number): RecordInput[] {
  if (event.type === 'renameSources' || event.type === 'renameStages') return [];
  const before = new Map(prev.tasks.map((t) => [taskId(t), t]));
  const kept = new Set(next.tasks.map(taskId));
  const present = next.tasks.flatMap((task): RecordInput[] => {
    const old = before.get(taskId(task));
    const ids = correlationOf(next, undefined, task);
    if (!old) return [{ event: 'task.discovered', level: 'info', ...ids, source: task.item.source ?? 'local', ...createdAt(task, now) }];
    return old.stage === task.stage ? [] : [{ event: 'task.moved', level: 'info', ...ids, from: old.stage, to: task.stage, by: MOVED_BY[event.type] ?? 'auto' }];
  });
  const gone = prev.tasks.filter((t) => !kept.has(taskId(t))).map((task): RecordInput => {
    const fields = { level: 'info' as const, ...correlationOf(prev, undefined, task), ...goneFields(prev, task, event) };
    const deleted = event.type === 'taskDeleted' || (event.type === 'closeTask' && task.created === true);
    return deleted ? { event: 'task.deleted', ...fields } : { event: 'task.closed', ...fields };
  });
  return [...present, ...gone];
}

type ApprovalEvent = Extract<HiveEvent, { type: 'approve' | 'feedback' | 'extendApproval' | 'approvalExpired' }>;
const isApprovalEvent = (event: HiveEvent): event is ApprovalEvent =>
  event.type === 'approve' || event.type === 'feedback' || event.type === 'extendApproval' || event.type === 'approvalExpired';

// The user's answer to a stage awaiting approval, timed from when it began awaiting; feedback carries only its text's reference
function approvalRecords(prev: State, event: HiveEvent, now: number): RecordInput[] {
  if (!isApprovalEvent(event)) return [];
  const id = event.type === 'approvalExpired' ? prev.workers.find((w) => w.runId === event.ptyId)?.activityId : event.activityId;
  const activity = prev.activities.find((a) => a.id === id);
  if (activity?.approval === undefined) return [];
  const fields = { level: 'info' as const, ...correlationOf(prev, undefined, taskOfActivity(prev, activity.id)), duration_ms: since(activity.approval.since, now) };
  switch (event.type) {
    case 'approve': return [{ event: 'approval.granted', ...fields }];
    case 'feedback': return [{ event: 'approval.rejected', ...fields, start: event.start, ...textRef(event.text) }];
    case 'extendApproval': return [{ event: 'approval.extended', ...fields }];
    case 'approvalExpired': return [{ event: 'approval.expired', ...fields }];
  }
}

// The model as configured: the stage's own, absent when the agent's default runs; a free session runs no stage
function modelOf(state: State, worker: Worker): { model?: string } {
  const task = worker.freeSession ? undefined : taskOfWorker(state, worker);
  const model = task && stageOf(state.stages, task.stage)?.model;
  return model === undefined ? {} : { model };
}

// A run that took a worker (a new run id), and one whose SessionStart just arrived
function runStarts(prev: State, next: State, now: number): RecordInput[] {
  return next.workers.flatMap((worker, i): RecordInput[] => {
    if (!occupied(worker)) return [];
    const old = prev.workers.find((w) => w.runId === worker.runId);
    if (!old) return [{ event: 'run.spawned', level: 'info', ...correlationOf(next, worker), worker: i + 1, ...modelOf(next, worker) }];
    return old.sessionId === undefined && worker.sessionId !== undefined
      ? [{ event: 'run.started', level: 'info', ...correlationOf(next, worker), spawn_latency_ms: since(worker.startedAt, now) }] : [];
  });
}

// A run that left its worker. The boot closes runs that died with the Hive: hive.crash_recovered counts those instead
function runEnds(prev: State, next: State, event: HiveEvent, now: number): RecordInput[] {
  if (event.type === 'boot') return [];
  return prev.workers.flatMap((worker): RecordInput[] => {
    if (!occupied(worker) || next.workers.some((w) => occupied(w) && w.runId === worker.runId)) return [];
    const fields = { level: 'info' as const, ...correlationOf(prev, worker), duration_ms: since(worker.startedAt, now) };
    return [worker.freeSession ? { event: 'free_session.ended', ...fields } : { event: 'run.exited', ...fields }];
  });
}

// A terminal the user opened that left the state, a task's or a workspace's: a human working beside the runs. The boot drops every terminal,
// dead with the Hive: none written then. A terminal is no stage run: its activity and task only
function terminalEnds(prev: State, next: State, event: HiveEvent, now: number): RecordInput[] {
  if (event.type === 'boot') return [];
  const kept = new Set(next.terminals.map((t) => t.terminalId));
  return prev.terminals.filter((t) => !kept.has(t.terminalId)).map((terminal): RecordInput => {
    const task = taskOfActivity(prev, terminal.activityId);
    const ids = compact({ task_id: task && taskId(task), ...visibleId(task), activity_id: terminal.activityId });
    return { event: 'terminal.ended', level: 'info', ...ids, duration_ms: since(terminal.startedAt, now), ...(terminal.command === undefined ? {} : { command: terminal.command }) };
  });
}

// What the user cut by hand (Stop, Restart) and a spawn that never started. A free session's stop is its end, free_session.ended's; a stop
// with no cause is hive_stop's or a command's timeout, not the user's. Restart runs only once no run is live: its duration is from the
// previous stage run's stop to the Restart
function cutRecords(prev: State, event: HiveEvent, now: number): RecordInput[] {
  if (event.type === 'stop') {
    if (event.cause === undefined) return [];
    const worker = prev.workers.find((w) => occupied(w) && w.runId === event.ptyId && !w.freeSession);
    return worker ? [{ event: 'run.stopped', level: 'info', ...correlationOf(prev, worker), duration_ms: since(worker.startedAt, now) }] : [];
  }
  if (event.type === 'spawnFailed') {
    const worker = prev.workers.find((w) => w.runId === event.ptyId);
    return [{ event: 'run.spawn_failed', level: 'error', ...(worker ? correlationOf(prev, worker) : {}), code: spawnFailureCode(event.message) }];
  }
  if (event.type !== 'restart') return [];
  const activity = prev.activities.find((a) => a.id === event.activityId);
  const task = activity && taskOfActivity(prev, activity.id);
  return task ? [{ event: 'run.restarted', level: 'info', ...correlationOf(prev, undefined, task), duration_ms: since(activity?.stoppedAt, now) }] : [];
}

// How a stage run started: feedback answering a held Stop or a handover queued on the activity (#134), a continue in the same pty, a Restart, a Continue,
// else a plain spawn
function runKind(prev: State, worker: Worker, event: HiveEvent, activityId: string): RunKind {
  if (event.type === 'feedback') return 'feedback';
  if (prev.workers.some((w) => w.runId === worker.runId)) return 'continue';
  if (event.type === 'restart') return 'restart';
  if (prev.activities.some((a) => a.id === activityId && a.handover !== undefined)) return 'feedback'; // #134: a transition's handover
  return event.type === 'continue' ? 'continue' : 'spawn';
}

/** The stage runs this reduction started (#742): each record whose stageRuns grew, with the run that took its activity. attempt is the count
 * the same reduce just wrote, so the derivation stays a function of its arguments. */
export function startedRuns(prev: State, next: State, event: HiveEvent, now: number): StartedRun[] {
  if (event.type === 'renameStages') return []; // #861: a rename re-keys stageRuns; it starts no run
  return next.activityRecords.flatMap((record) => {
    const before = recordOf(prev, record.id)?.stageRuns ?? {};
    const worker = next.workers.find((w) => occupied(w) && w.activityId === record.id && !w.freeSession);
    const ptyId = worker?.runId;
    if (worker === undefined || ptyId === undefined) return [];
    return Object.entries(record.stageRuns ?? {}).filter(([stage, count]) => count > (before[stage] ?? 0)).map(([stage, attempt]) => ({
      ptyId, waitedMs: runTime(worker, now).waitingMs,
      correlation: compact({ ...correlationOf(next, worker), stage, attempt, run_kind: runKind(prev, worker, event, record.id) }),
    }));
  });
}

// The rule that holds the signal where it is, when the floor and not the manual signal decided it, and only one rule could have
function ruleOf(state: State, limits: EffectiveLimits, now: number): { rule?: string; usage_percent?: number } {
  const [rule, other] = limits.signal === state.signal ? [] : limits.signalRules;
  if (!rule || other) return {};
  const percent = rulePercents(state, now)(rule);
  return { rule: `${rule.source}≥${rule.percent}`, usage_percent: Math.round(percent) };
}

// How many runs the cap counts against the cap, whenever either moves
function capacityRecords(prev: State, next: State): RecordInput[] {
  const active = workerCount(next.workers);
  const same = active === workerCount(prev.workers) && prev.maxConcurrent === next.maxConcurrent;
  return same ? [] : [{ event: 'workers.changed', level: 'info', active, max: next.maxConcurrent }];
}

/** The signal the gate applies against the last one written (#742): the clock moves it too, so the caller keeps `last` and asks after every
 * dispatch, a kept state included. The first ask (`last` undefined) writes the signal as it stands. */
export function signalRecords(last: Signal | undefined, prev: State, next: State, now: number): { signal: Signal; records: RecordInput[] } {
  const limits = effectiveLimits(next, now);
  const from = last ?? effectiveLimits(prev, now).signal;
  if (last !== undefined && from === limits.signal) return { signal: limits.signal, records: [] };
  return { signal: limits.signal, records: [{ event: 'signal.changed', level: 'info', from, to: limits.signal, ...ruleOf(next, limits, now) }] };
}

const prTimes = (pr: TaskPr, task: Task | undefined, now: number): { since_opened_ms?: number; since_stage_started_ms?: number } => compact({
  since_opened_ms: pr.openedAt === undefined ? undefined : since(pr.openedAt, now),
  since_stage_started_ms: task?.enteredAt === undefined ? undefined : since(task.enteredAt, now),
});

// A PR a record gained, and one the poll read merged or closed
function prRecords(prev: State, next: State, event: HiveEvent, now: number): RecordInput[] {
  return next.activityRecords.flatMap((record) => {
    const was = new Map((recordOf(prev, record.id)?.prs ?? []).map((pr) => [pr.url, pr]));
    const task = taskOfActivity(next, record.id);
    const fields = { level: 'info' as const, ...correlationOf(next, undefined, task) };
    return (record.prs ?? []).flatMap((pr): RecordInput[] => {
      const old = was.get(pr.url);
      const number = Number(prNumber(pr.url));
      if (!old) return [{ event: 'pr.opened', ...fields, pr: number }];
      if (event.type !== 'prStates' || old.state === pr.state || pr.state === 'open') return [];
      return [{ event: 'pr.state', ...fields, pr: number, state: pr.state, ...prTimes(pr, task, now) }];
    });
  });
}

// A boot that found runs still alive in the saved state: the same condition that sets the crash notice dismissCrash clears
function crashRecords(prev: State, next: State, event: HiveEvent): RecordInput[] {
  if (event.type !== 'boot' || next.crash === undefined || next.crash === prev.crash) return [];
  return [{ event: 'hive.crash_recovered', level: 'error', workers: prev.workers.filter(occupied).length }];
}

const awaitsApproval = (state: State, worker: Worker): boolean => state.activities.some((a) => a.id === worker.activityId && a.approval !== undefined);
// shutdown when done stops a waiting worker on any event, with no Stop of the user's (#233): the run is still alive, its activity stopped
const stoppedByHive = (state: State, worker: Worker): boolean => state.activities.some((a) => a.id === worker.activityId && a.stopped === true);
// #805: after hive_done a StopFailure is the run's Stop (applyHook), so it ends the stage as one
const ownStop = (event: HiveEvent, ptyId: string): boolean =>
  event.type === 'hook' && event.ptyId === ptyId && (event.payload.hook_event_name === 'Stop' || event.payload.hook_event_name === 'StopFailure');

// How a stage run ended in this reduction, if it did. A run held for approval already ended at its Stop; the tracker writes each end once
function stageOutcome(next: State, event: HiveEvent, worker: Worker, ptyId: string): StageOutcome | undefined {
  if (event.type === 'quit') return 'killed';
  if (event.type === 'stop' && event.ptyId === ptyId) return worker.status === 'approval' ? undefined : event.cause === undefined ? 'agent_stop' : 'stop';
  if (event.type === 'spawnFailed' && event.ptyId === ptyId) return 'failed';
  if (worker.done && ownStop(event, ptyId)) return awaitsApproval(next, worker) ? 'approval' : 'done';
  if (next.workers.some((w) => occupied(w) && w.runId === ptyId)) return stoppedByHive(next, worker) ? 'killed' : undefined;
  if (worker.status === 'approval') return undefined;
  return taskOfWorker(next, worker) === undefined ? 'killed' : 'exit';
}

/** The stage runs this reduction ended (#742), with the worker's waits so far: the server's tracker completes each into stage.ended. */
export function endedStageRuns(prev: State, next: State, event: HiveEvent, now: number): StageRunEnd[] {
  if (prev === next) return [];
  return prev.workers.flatMap((worker): StageRunEnd[] => {
    const ptyId = worker.runId;
    if (ptyId === undefined || worker.status === 'empty' || worker.freeSession) return [];
    const outcome = stageOutcome(next, event, worker, ptyId);
    return outcome ? [{ ptyId, outcome, waitedMs: runTime(worker, now).waitingMs }] : [];
  });
}

// A turn that ended on an API error (#805): the reducer's decision, asked again of the state it decided on; the error class only, never the
// payload's details or the agent's last message. A child's StopFailure leaves the state as it was, so deriveEvents never gets here for it;
// after hive_done the failure is the run's Stop, no API error
function apiErrorRecords(prev: State, event: HiveEvent, now: number): RecordInput[] {
  if (event.type !== 'hook' || event.payload.hook_event_name !== 'StopFailure') return [];
  const worker = prev.workers.find((w) => occupied(w) && w.runId === event.ptyId);
  if (!worker || worker.done) return [];
  const decision = decideStopFailure(prev, worker, apiErrorOf(event.payload), now);
  const failure = decision.failure === undefined ? {} : { failure: decision.failure };
  const wait = decision.action === 'backoff' ? { wait_ms: Math.max(0, decision.until - now) } : {};
  return [{ event: 'run.api_error', level: 'warn', ...correlationOf(prev, worker), error: decision.error, action: decision.action, ...failure, ...wait }];
}

// A wait for CI (#834): its end with a verdict (a read or the failed logs; a Stop is no verdict and writes none), with how long it waited, and
// the first read whose required fell back to all. Derived from the activity's ci before and after, as describeChanges derives hive.log's lines
function ciRecords(prev: State, next: State, event: HiveEvent, now: number): RecordInput[] {
  if (event.type !== 'ciRead' && event.type !== 'ciClock' && event.type !== 'ciFailed') return [];
  const before = prev.activities.find((a) => a.id === event.activityId)?.ci;
  if (before === undefined) return [];
  const after = next.activities.find((a) => a.id === event.activityId);
  const ids = correlationOf(prev, undefined, taskOfActivity(prev, event.activityId));
  if (after?.ci !== undefined) return after.ci.fellBack && !before.fellBack ? [{ event: 'ci.fallback', level: 'info', ...ids }] : [];
  const failed = after?.stopped === true;
  return [{ event: 'ci.ended', level: failed ? 'warn' : 'info', ...ids, verdict: failed ? 'failed' : 'passed', duration_ms: since(before.since, now) }];
}

/** Every record one reduction yields (#742): tasks, approvals, runs, stage starts, capacity, PRs, a crash, an API error (#805), a wait for CI (#834). Nothing when the reducer returned
 * the state it was given. */
export function deriveEvents(prev: State, next: State, event: HiveEvent, now: number): RecordInput[] {
  if (prev === next) return [];
  const stageStarts = startedRuns(prev, next, event, now).map((run): RecordInput => ({ event: 'stage.started', level: 'info', ...run.correlation }));
  return [
    ...taskRecords(prev, next, event, now), ...approvalRecords(prev, event, now), ...runStarts(prev, next, now), ...runEnds(prev, next, event, now), ...terminalEnds(prev, next, event, now),
    ...cutRecords(prev, event, now), ...stageStarts, ...capacityRecords(prev, next), ...prRecords(prev, next, event, now), ...crashRecords(prev, next, event),
    ...apiErrorRecords(prev, event, now), ...ciRecords(prev, next, event, now),
  ];
}
