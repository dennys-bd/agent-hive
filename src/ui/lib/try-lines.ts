import { activityOf } from '../../activities.js';
import { retryTransition } from '../../transitions.js';
import type { Activity, State, Task, Transition, TryRecord } from '../../types.js';
import { triggerLabel } from './flow-labels.js';

// What the details panel's tries read (#916): the transition a task ran out of, through the retry route's own rule, and the try log in the
// order the panel lists it. Relative .js imports: the root tsc compiles this file.

/** What the exhausted block names (#916): the spent transition, its trigger as a pill reads it, its limit, where it went back to. A type, so its
 * fields pass as t()'s vars. */
export type Exhausted = { transition: Transition; trigger: string; max: number; destination: string };

/** The transition the task's tries ran out on, as POST /tasks/:id/retry finds it; undefined for any other stop, or once it was removed or renamed. */
export function exhaustedOf(state: Pick<State, 'transitions' | 'activities' | 'activityRecords'>, task: Task): Exhausted | undefined {
  const transition = retryTransition(state, task, activityOf(state, task.item.itemId)?.error);
  if (transition === undefined) return undefined;
  return { transition, trigger: triggerLabel(transition.when, transition.verdict), max: transition.maxTries ?? 0, destination: transition.to };
}

/** The try log newest first (by at, then by n), only `key`'s records when given; a new array, the log untouched. */
export function recordsOf(activity: Pick<Activity, 'tryLog'> | undefined, key?: string): TryRecord[] {
  const kept = (activity?.tryLog ?? []).filter((r) => key === undefined || r.transition === key);
  return kept.sort((a, b) => b.at.localeCompare(a.at) || b.n - a.n); // filter already copied: sort writes to no input
}
