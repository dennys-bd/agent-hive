// The flow's tree grouping (#34): which tree a node's task belongs to, the order a node lists a tree in, and the colour of a parent's segment
// per child. Pure, read off the whole task list through task-tree's walks (#28), so a node holding only a deep child still names its real root.
import { depthOf, descendants, isDone, parentOf, rootOf } from '../../task-tree.js';
import type { State, Task } from '../../types.js';
import type { TaskState } from './status.js';
import { type TaskStateInput, taskState } from './task-state.js';

/** A node's group (#34): a root and the node's cards in it, each with its depth; no root is "no tree". */
export interface TreeGroup { root?: Task; tasks: Array<{ task: Task; depth: number }> }

const NO_TREE = 'none';
const idOf = (task: Task): string => task.item.itemId;

// A parent or a child that is a task in the list; one that is no task does not make a tree (#28). ponytail: each walk scans the list, O(n²)
// per node; index the tasks by itemId if a flow ever holds thousands
const inTree = (all: readonly Task[], task: Task): boolean =>
  parentOf(all, idOf(task)) !== undefined || descendants(all, idOf(task)).length > 0;

/** Whether any task of the list has a parent or a child in it: what the tree toggle reads while flowView holds no choice (#34). */
export const hasTree = (all: readonly Task[]): boolean => all.some((task) => inTree(all, task));

/** A group's collapse key (#34): per node, so collapsing a tree in one stage never hides it in another. */
export const collapseKey = (stage: string, root?: Task): string => `${stage}\u0000${root === undefined ? NO_TREE : idOf(root)}`;

/** A node's shown tasks by tree (#34): one group per root, where its first task sat; inside, the root first when shown, then depth first in
 * sub-issue order; "no tree" last, only when some task is in none. */
export function groupTasks(all: readonly Task[], shown: readonly Task[]): TreeGroup[] {
  const treed = shown.filter((task) => inTree(all, task));
  const loose = shown.filter((task) => !inTree(all, task));
  const rootFor = (task: Task): Task => rootOf(all, idOf(task)) ?? task;
  const roots = [...new Set(treed.map(rootFor))]; // a Set keeps first-seen order: the Hive's order stays the outer order
  const trees = roots.map((root): TreeGroup => {
    const order = [root, ...descendants(all, idOf(root))].map(idOf);
    // A member the walk down misses (links that disagree on the wire) still shows, last, rather than vanish
    const rank = (task: Task): number => (order.includes(idOf(task)) ? order.indexOf(idOf(task)) : order.length);
    const members = treed.filter((task) => rootFor(task) === root).sort((a, b) => rank(a) - rank(b));
    return { root, tasks: members.map((task) => ({ task, depth: depthOf(all, idOf(task)) })) };
  });
  return loose.length === 0 ? trees : [...trees, { tasks: loose.map((task) => ({ task, depth: 0 })) }];
}

/** A direct child's segment on its parent's card (#34): done by the tree's one rule, empty for a child with no task still open, else the
 * child's own state (new reads as empty in every colour). */
export function segmentTone(state: Pick<State, 'tasks'> & TaskStateInput, parent: Task, childId: string, lastStage: string): TaskState | 'done' {
  if (isDone(state.tasks, parent, childId, lastStage)) return 'done';
  const child = state.tasks.find((task) => idOf(task) === childId);
  return child === undefined ? 'empty' : taskState(child, state);
}
