import { activityOf, recordsOf, withActivity, withRecord } from './activities.js';
import { continueInPlace, none, type Reduced } from './reducer-kit.js';
import { HANDOFF_PROMPT } from './spawn.js';
import { feedbackSession, openFeedbackSession } from './task-runs.js';
import { stageOf, taskId } from './tasks.js';
import type { EndOf } from './transit.js';
import { takeTry, transitionKey } from './transitions.js';
import { END, type Activity, type State, type Task, type Transition } from './types.js';

// The handoff between sessions (#692): when a stage ends and the next stage asks for one, the ending stage's session writes it before the task
// moves. Pure and immutable, like the reducer that calls these.

/** Whether a stage end must ask for a handoff first (#692, #134): the transition it fires leads to a stage with handoff, none is being written
 * already, the transition has a try left (spent, it halts with TRIES_OUT, so no handoff turn runs for it), and the session that ran the stage
 * (a gate's: the one it reviews) is there to write it. */
export function needsHandoff(state: Pick<State, 'stages' | 'activities' | 'activityRecords'>, task: Task, exit: Transition | undefined): exit is Transition {
  const live = activityOf(state, taskId(task));
  if (exit === undefined || exit.to === END || live?.handoffPending !== undefined || takeTry(live, exit) === undefined) return false;
  return stageOf(state.stages, exit.to)?.handoff === true && feedbackSession(task, state) !== undefined;
}

/** The task's records without a `handoff` result: one written for an earlier stage must not reach a later one (#692). */
function withoutHandoff(state: State, id: string): State {
  return recordsOf(state, id).reduce((s, { result, ...record }) => {
    if (!result || !('handoff' in result)) return s;
    const { handoff: _handoff, ...rest } = result;
    return withRecord(s, { ...record, ...(Object.keys(rest).length > 0 ? { result: rest } : {}) });
  }, state);
}

/** The task stays in its stage, its activity marked, and its session is asked for the handoff the way feedback reaches it (#268, #483): a run
 * at its Stop (`ptyId`) is answered in place; a session open in the user's own run has it typed in; otherwise it is queued for the next spawn,
 * which resumes that session. The run's next hive_done and Stop, or a free session's hive_done, move the task, keyed by the transition the run's
 * next end takes (#134), with the user's `feedback` that transition fires with. An approve's state still has its approval, dropped here (#812),
 * so the session asked is the free one the approval names. */
export function askHandoff(asked: State, task: Task, exit: Transition, ptyId?: string, feedback?: string): Reduced {
  const state = withoutHandoff(asked, taskId(task)); // only a handoff written in answer to this request may reach the next stage
  const found = activityOf(state, taskId(task));
  if (!found) return none(state); // a stage end always has its activity (#629)
  const { approval: _approval, ...answered } = found; // #812: an approve passes its approval in, so the lookups below read the free session it names
  const live: Activity = { ...answered, handoffPending: transitionKey(exit), ...(feedback === undefined ? {} : { handoffFeedback: feedback }) };
  const marked = withActivity(state, live);
  const worker = ptyId === undefined ? undefined : state.workers.find((s) => s.runId === ptyId);
  const stage = stageOf(state.stages, task.stage);
  if (worker && ptyId !== undefined && stage) return continueInPlace(marked, worker, ptyId, task, stage, [], HANDOFF_PROMPT, true);
  const open = openFeedbackSession(task, state);
  if (open) return { state: marked, effects: [{ type: 'input', ptyId: open.runId, text: HANDOFF_PROMPT }] };
  const session = feedbackSession(task, state); // needsHandoff checked it is there: the next spawn resumes it
  return none(withActivity(state, { ...live, handover: { prompt: HANDOFF_PROMPT, ...(session ? { sessionId: session.id } : {}) } }));
}

/** The activity without its pending handoff (#134): the transition it waited on fires now, and one that loops to its own stage makes no
 * entry to clear it. */
export function withoutPending(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  if (live === undefined || (live.handoffPending === undefined && live.handoffFeedback === undefined)) return state;
  const { handoffPending: _pending, handoffFeedback: _feedback, ...rest } = live;
  return withActivity(state, rest);
}

/** The end a pending handoff's transition fires with (#134): the run's own end, with the feedback the handoff waited on when there was one. */
export const pendingEnd = (activity: Pick<Activity, 'handoffFeedback'> | undefined, end: EndOf): EndOf =>
  (activity?.handoffFeedback === undefined ? end : { ...end, feedback: activity.handoffFeedback });
