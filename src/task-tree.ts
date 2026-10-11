import type { Task } from './types.js';

/** How many nodes under a parent are done, out of how many (#28). A child with no task still counts, as one node. */
export interface TreeCount { done: number; total: number }

const NONE: TreeCount = { done: 0, total: 0 };

const taskOf = (tasks: readonly Task[], itemId: string): Task | undefined => tasks.find((t) => t.item.itemId === itemId);

// A node is done by one rule, parent or leaf: its task sits in the last stage, or it has no task (it left the Hive, or was never on it) and
// the parent that lists it says GitHub closed it
function isDone(tasks: readonly Task[], parent: Task, childId: string, lastStage: string): boolean {
  const child = taskOf(tasks, childId);
  return child === undefined ? (parent.item.closedChildren ?? []).includes(childId) : child.stage === lastStage;
}

/** The parent's task; a parent that is no task in the list (filtered out, hidden, ended) reads as none, so its child is a root. */
export function parentOf(tasks: readonly Task[], itemId: string): Task | undefined {
  const parent = taskOf(tasks, itemId)?.item.parent;
  return parent === undefined ? undefined : taskOf(tasks, parent);
}

// The task and its ancestors, nearest first. A repeat ends the walk: GitHub forbids cycles, but the wire is not trusted
function lineage(tasks: readonly Task[], itemId: string): Task[] {
  const chain: Task[] = [];
  for (let t = taskOf(tasks, itemId); t !== undefined && !chain.includes(t); t = parentOf(tasks, t.item.itemId)) chain.push(t);
  return chain;
}

/** The topmost ancestor in the list, the task itself when it has none; undefined when the item is no task. */
export const rootOf = (tasks: readonly Task[], itemId: string): Task | undefined => lineage(tasks, itemId).at(-1);

/** The steps up to the root: 0 for a root, 1 for its direct children. */
export const depthOf = (tasks: readonly Task[], itemId: string): number => Math.max(lineage(tasks, itemId).length - 1, 0);

/** The tasks below the item, depth first in sub-issue order, each once, the item excluded; a child with no task (and so no known children) is skipped. */
export function descendants(tasks: readonly Task[], itemId: string): Task[] {
  const seen = new Set<string>([itemId]);
  const walk = (id: string): Task[] => (taskOf(tasks, id)?.item.children ?? []).flatMap((childId) => {
    if (seen.has(childId)) return [];
    seen.add(childId);
    const child = taskOf(tasks, childId);
    return child === undefined ? [] : [child, ...walk(childId)];
  });
  return walk(itemId);
}

/** Done over the item's direct children; `total` is every child it lists, task or not. */
export function progress(tasks: readonly Task[], itemId: string, lastStage: string): TreeCount {
  const parent = taskOf(tasks, itemId);
  if (parent === undefined) return NONE;
  const children = parent.item.children ?? [];
  return { done: children.filter((childId) => isDone(tasks, parent, childId, lastStage)).length, total: children.length };
}

/** Done over every node below the item, intermediate parents and leaves alike. It walks the children ids rather than `descendants`, because
 * a child with no task still counts, as one node with nothing under it. */
export function treeProgress(tasks: readonly Task[], itemId: string, lastStage: string): TreeCount {
  const seen = new Set<string>([itemId]);
  const walk = (parent: Task): TreeCount => (parent.item.children ?? []).reduce<TreeCount>((sum, childId) => {
    if (seen.has(childId)) return sum;
    seen.add(childId);
    const child = taskOf(tasks, childId);
    const below = child === undefined ? NONE : walk(child);
    const done = isDone(tasks, parent, childId, lastStage) ? 1 : 0;
    return { done: sum.done + done + below.done, total: sum.total + 1 + below.total };
  }, NONE);
  const task = taskOf(tasks, itemId);
  return task === undefined ? NONE : walk(task);
}

/** Whether any task of the item's whole tree (its root and all the root's descendants) meets `isStarted`. What "started" means is the
 * caller's (#32). */
export function treeStarted(tasks: readonly Task[], itemId: string, isStarted: (task: Task) => boolean): boolean {
  const root = rootOf(tasks, itemId);
  return root !== undefined && [root, ...descendants(tasks, root.item.itemId)].some(isStarted);
}
