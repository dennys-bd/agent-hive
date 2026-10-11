// The flow's focus on a subtree (#35): which tasks a focus covers and the path a trail climbs back up. Pure, read off the whole task list
// through task-tree's walks (#28), so the focus is one derivation whatever the source pick, the filters or the search show.
import { descendants, lineage } from '../../task-tree.js';
import type { Task } from '../../types.js';

const idOf = (task: Task): string => task.item.itemId;

/** The itemIds a focus on `itemId` covers: the task and every task below it. Undefined when the itemId is no task, so a focused task that
 * left the list reads as no focus at all. */
export function focusSet(all: readonly Task[], itemId: string): ReadonlySet<string> | undefined {
  if (!all.some((task) => idOf(task) === itemId)) return undefined;
  return new Set([itemId, ...descendants(all, itemId).map(idOf)]);
}

/** The trail's path: the root first, the focused task last. A copy is reversed, so lineage's own order is never touched. */
export const focusTrail = (all: readonly Task[], itemId: string): Task[] => [...lineage(all, itemId)].reverse();
