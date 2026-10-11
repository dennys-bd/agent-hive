// The task's own status (#663): what the flow's task, the detail's status box, the home's recent rows and the Activities sidebar show. A
// session at work says what is happening now; once none works or waits, the activity has ended its cycle and review and approval are the
// task's, read from its records and its activity. Derived: nothing of it is stored. Relative .js imports: node --test loads it through home.ts.
import { activityOf, prsOf, resultOf } from '../../activities.js';
import { decompositionPending } from '../../decomposition.js';
import { hasOpenPr } from '../../pull-requests.js';
import { inAction, isQueued, type WorkersState, workersOf } from '../../tasks.js';
import { TRIES_OUT, type Activity, type Task, type State } from '../../types.js';
import { mostUrgent, type TaskState } from './status.js';

/** What taskState reads: the workers and activities, and the stages, whose queue keeps an open PR from reading review (#15). Without them no
 * task is queued, so a caller that holds none (a test, the terminal's harness) reads an open PR as review, as before. */
export type TaskStateInput = WorkersState & Partial<Pick<State, 'stages'>>;

/** Whether a run is at work (#663): working or waiting, or waiting out an API error, which still holds its run (#805). A held approval run is
 * idle until approve or feedback (#268). */
export const isLive = (status: TaskState): boolean => status === 'working' || status === 'waiting' || status === 'backoff';

/** When the Hive retries the task's run that waits out an API error (#805); undefined with none. */
export const backoffUntil = (task: Task, state: WorkersState): string | undefined =>
  workersOf(state, task).find((worker) => worker.status === 'backoff')?.backoff?.until;

/** The task's status (#663): the most urgent of its sessions at work; else working while a stage action is in flight, a CI wait or a commands
 * stage (#15: the card's n/m says which); else review while any of its records has an open PR and the task is not queued to run (#15: review
 * wins over approval, as approving the PR can release it); else approval while its live activity awaits one; else empty; else new while the
 * task has no live activity (#727). */
export function taskState(task: Task, state: TaskStateInput): TaskState {
  const live = mostUrgent(workersOf(state, task).filter((worker) => isLive(worker.status)));
  if (live !== 'empty') return live;
  const activity = activityOf(state, task.item.itemId);
  if (inAction(activity)) return 'working';
  if (hasOpenPr(prsOf(state, task.item.itemId)) && !isQueued(task, state.stages ?? [], state)) return 'review';
  if (activity?.approval) return 'approval';
  return activity === undefined ? 'new' : 'empty'; // #727: new until the task has an activity
}

/** The task's live activity while its approval is the user's to answer (#829): it carries one and no session of the task is live, so the
 * task reads approval or review. A session working, waiting or backing off is where the user answers instead. Every door to aprovar and
 * enviar feedback… reads this one rule (the status box, both menus, the A and F keys, the search, the feedback dialog and the flow's button), so
 * none is left open. */
export function answerableActivity(task: Task, state: TaskStateInput): Activity | undefined {
  const live = activityOf(state, task.item.itemId);
  return live?.approval !== undefined && !isLive(taskState(task, state)) ? live : undefined;
}

/** Whether the task's approval goes through criar issues (#865): its result holds a decomposition not on GitHub yet, and a source exists to
 * write it to, as the approve route's guard reads it. The detail's button and the A key read this one rule. ponytail: every source is GitHub
 * today and State names the sources, not their kind; read the kind here once another adapter lands. */
export const createsIssues = (task: Task, state: Pick<State, 'activityRecords' | 'syncs'>): boolean =>
  Object.keys(state.syncs).length > 0 && decompositionPending(resultOf(state, task.item.itemId));

/** Whether the task stopped out of tries (#913): its live activity halted with TRIES_OUT. The card and the node read it as destructive. */
export const isExhausted = (task: Task, state: Pick<State, 'activities' | 'activityRecords'>): boolean =>
  activityOf(state, task.item.itemId)?.error?.startsWith(TRIES_OUT) ?? false;
