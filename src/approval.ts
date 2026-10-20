import { openFeedbackSession } from './task-runs.js';
import { askHandoff, needsHandoff } from './handoff.js';
import { taskId, stageOf } from './tasks.js';
import { advance, type EndOf, keepsRun, take, withoutHandover } from './transit.js';
import { answerable, exitOf } from './transitions.js';
import { activityOf, slugOf, taskOfWorker, withActivity } from './activities.js';
import { continueInPlace, dropWorker, releaseWorker, none, patchedWorker, type Reduced, releaseRun, withTask } from './reducer-kit.js';
import { APPROVAL_HOLD_MAX_MIN, END, type Activity, type Task, type Stage, type Transition, type Worker, type State } from './types.js';

// A stage that ended in an approval stage (#268): the task waits for the user's approve or feedback. Pure and immutable, like the reducer
// that calls these; the server holds the Stop's HTTP answer (hold / release) and runs the rest.

const MINUTE_MS = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

type Held = Worker & { runId: string };

/** The task's activity with its hold forgotten (#268, #629): approval stays, without `until`. What every path that frees a held worker stores. */
export function withoutHold(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  return live?.approval?.until === undefined ? state : withActivity(state, { ...live, approval: { since: live.approval.since } });
}

interface Awaiting { task: Task; activity: Activity & Required<Pick<Activity, 'approval'>> }

// The task awaiting the user, and its activity, which carries the approval (#629)
function awaiting(state: State, id: string): Awaiting | undefined {
  const task = state.tasks.find((c) => taskId(c) === id);
  const activity = task && activityOf(state, id);
  return task && activity?.approval ? { task, activity: { ...activity, approval: activity.approval } } : undefined;
}

// The activity with its approval answered
const answeredActivity = ({ approval: _approval, ...activity }: Activity): Activity => activity;

// #812: the user's answer as an end that names the free session the approval holds: the transition's handover resumes it (transit.ts endedRun)
const withApprovalSession = (activity: Activity, end: EndOf): EndOf =>
  (activity.approval?.sessionId === undefined ? end : { ...end, sessionId: activity.approval.sessionId });

// the worker holding the task's Stop: its stage run, in status approval
const heldWorker = (state: State, activity: Activity): Held | undefined =>
  state.workers.find((s): s is Held => s.id === activity.workerId && s.status === 'approval' && s.runId !== undefined);

// A held run ends (#268), as finish's kill does: the worker frees, its time joins the task as `state` holds it, the held Stop gets no
// decision, then the process dies.
function endRun(state: State, worker: Worker, ptyId: string, slug: string): Reduced {
  const freed = releaseRun({ ...state, workers: releaseWorker(state.workers, worker) }, worker, Date.now());
  return { state: freed, effects: [{ type: 'release', ptyId }, { type: 'kill', slug, ptyId }] };
}

/** A Stop after hive_done in an approval stage (#268): no source write, the task waits for the user. When the approved transition keeps the
 * run's session (#134), the worker holds the Stop for the window (status approval, the hold effect); otherwise the run ends as finish's kill does, and the
 * task is not stopped: its stage reached hive_done. */
export function awaitApproval(state: State, ptyId: string, task: Task): Reduced {
  const worker = state.workers.find((s) => s.runId === ptyId);
  if (!worker) return none(state);
  const now = Date.now();
  const since = iso(now);
  const live = activityOf(state, taskId(task));
  if (!live) return none(state); // a stage run always has its activity (#629)
  const exit = exitOf(state, task.stage, 'approved');
  const next = exit === undefined || exit.to === END ? undefined : stageOf(state.stages, exit.to);
  if (exit === undefined || next === undefined || !keepsRun(state, task, exit, next)) { // #134: hold only when approving goes on in this run's session
    const { workerId: _workerId, ...dropped } = live;
    const waiting = withActivity(withTask(state, task), { ...dropped, approval: { since } });
    return { state: releaseRun({ ...waiting, workers: releaseWorker(state.workers, worker) }, worker, now), effects: [{ type: 'kill', slug: slugOf(state, taskId(task)), ptyId }] };
  }
  const until = iso(now + state.approvalMinutes * MINUTE_MS);
  const workers = state.workers.map((s) => (s.id === worker.id ? patchedWorker(s, { status: 'approval', question: undefined }) : s));
  return { state: withActivity(withTask({ ...state, workers }, task), { ...live, approval: { since, until } }), effects: [{ type: 'hold', ptyId, until }] };
}

/** Whether a worker whose stage ended may go on in place into `next` (the orchestrator's canContinue), asked on the state as if freed. */
export type CanContinue = (freed: State, worker: Worker, moved: Task, next: Stage) => boolean;

/** The user's answer as a stage end (#268, #134): approve, or feedback to another stage, fires its transition as finish does. A held worker goes
 * on in place when the transition keeps its session and `canContinue` allows it (#321); otherwise the held run ends and the fill decides.
 * Without a worker the task joins its destination with its handover, or leaves on end. A handoff the destination asks for comes first (#692),
 * carrying the feedback. With no transition for the answer, nothing changes: the task keeps awaiting (the route refuses it first). */
export function answer(state: State, id: string, end: EndOf, canContinue: CanContinue): Reduced {
  const found = awaiting(state, id);
  if (!found || !answerable(state, found.task, end.trigger)) return none(state);
  const { task } = found;
  const worker = heldWorker(state, found.activity);
  const answered = withActivity(state, answeredActivity(found.activity));
  const exit = exitOf(state, task.stage, end.trigger);
  // #692; #812: askHandoff answers the approval itself, so its lookups still read the session the approval names
  if (needsHandoff(state, task, exit)) return askHandoff(state, task, exit, worker?.runId, end.feedback);
  const answerEnd = withApprovalSession(found.activity, end);
  const { state: advanced, moved, next, effects, transition, handover } = advance(worker ? dropWorker(answered, task) : answered, task, answerEnd);
  if (!worker) return { state: advanced, effects };
  const freed: State = { ...advanced, workers: releaseWorker(state.workers, worker) }; // what fill would see, as in finish
  if (next && transition && keepsRun(state, task, transition, next) && canContinue(freed, worker, moved, next)) {
    return continueInPlace(freed, worker, worker.runId, moved, next, effects, handover?.prompt, next.name === task.stage);
  }
  const ended = endRun(advanced, worker, worker.runId, slugOf(state, taskId(task))); // endRun frees the worker itself
  return { state: ended.state, effects: [...effects, ...ended.effects] };
}

/** Aprovar (#268): the approved transition (#134). */
export const approve = (state: State, id: string, canContinue: CanContinue): Reduced => answer(state, id, { trigger: 'approved' }, canContinue);

// The feedback transition when it loops back to the task's own stage (#134): today's paths answer it there
function ownFeedback(state: State, found: Awaiting): Transition | undefined {
  const exit = exitOf(state, found.task.stage, 'feedback');
  return exit?.to === found.task.stage ? exit : undefined;
}

/** Feedback on a held worker, to its own stage (#268, #134): the Stop is answered with the transition's prompt whatever the signal, the worker
 * working again, approval gone. Undefined when no worker holds the Stop, the feedback goes elsewhere, or it resumes another session. */
export function answerFeedback(state: State, id: string, text: string): Reduced | undefined {
  const found = awaiting(state, id);
  const worker = found && heldWorker(state, found.activity);
  const exit = found && ownFeedback(state, found);
  const stage = found && stageOf(state.stages, found.task.stage);
  if (!found || !worker || !exit || !stage || !keepsRun(state, found.task, exit, stage)) return undefined;
  const taken = take(withActivity(state, answeredActivity(found.activity)), found.task, exit, { trigger: 'feedback', feedback: text });
  return continueInPlace(taken.state, worker, worker.runId, taken.moved, stage, taken.effects, taken.handover?.prompt, true);
}

/** Feedback to its own stage with the user's own session open on the conversation the transition resumes (#483, #134): its prompt is typed
 * there instead of a spawn on the same session. Undefined when a worker holds the Stop, no such session is open, or the feedback goes elsewhere. */
export function typeFeedback(state: State, id: string, text: string): Reduced | undefined {
  const found = awaiting(state, id);
  const open = found && !heldWorker(state, found.activity) ? openFeedbackSession(found.task, state) : undefined;
  const exit = found && ownFeedback(state, found);
  if (!found || !open || !exit) return undefined;
  const taken = take(withActivity(state, answeredActivity(found.activity)), found.task, exit, withApprovalSession(found.activity, { trigger: 'feedback', feedback: text }));
  if (taken.handover === undefined || taken.handover.sessionId !== open.sessionId) return undefined; // it resumes another session: the task queues instead
  return { state: withoutHandover(taken.state, found.task), effects: [...taken.effects, { type: 'input', ptyId: open.runId, text: taken.handover.prompt }] };
}

/** Estender (#268): the held Stop waits `approvalMinutes` from now, never past its arrival plus APPROVAL_HOLD_MAX_MIN (the Stop hook's own
 * timeout); the hold effect moves the server's timer. A task whose Stop no worker holds: nothing. */
export function extendApproval(state: State, id: string): Reduced {
  const found = awaiting(state, id);
  const worker = found && heldWorker(state, found.activity);
  if (!found || !worker) return none(state);
  const { approval } = found.activity;
  const ceiling = Date.parse(approval.since) + APPROVAL_HOLD_MAX_MIN * MINUTE_MS;
  const until = iso(Math.min(Date.now() + state.approvalMinutes * MINUTE_MS, ceiling));
  return { state: withActivity(state, { ...found.activity, approval: { ...approval, until } }), effects: [{ type: 'hold', ptyId: worker.runId, until }] };
}

/** The server's hold timer ran out (#268): only a worker still holding a Stop whose `until` has passed; answered, extended or freed meanwhile,
 * nothing changes. The run ends and the task keeps approval without until. */
export function approvalExpired(state: State, ptyId: string): Reduced {
  const worker = state.workers.find((s) => s.runId === ptyId && s.status === 'approval');
  const task = worker && taskOfWorker(state, worker);
  const until = task && activityOf(state, taskId(task))?.approval?.until;
  if (!worker || !task || until === undefined || Date.parse(until) > Date.now()) return none(state);
  return endRun(withoutHold(dropWorker(state, task), task), worker, ptyId, slugOf(state, taskId(task)));
}
