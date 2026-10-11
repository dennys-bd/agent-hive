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

/** Whether the task has a parent or a child that is a task in the list; one that is no task does not make a tree (#28). The flow's grouping
 * (#34) and the details' tree section (#36) read this one rule. ponytail: each walk scans the list, O(n²) per node; index the tasks by itemId
 * if a flow ever holds thousands */
export const inTree = (all: readonly Task[], task: Task): boolean =>
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

/** A row of a stage node's list (#34): a group's header, or a card with its indent. A header's `itemIds` are its tasks in the node, collapsed
 * ones included, so the focus (#35) can tell a header with none of them in it. */
export type NodeRow =
  | { kind: 'group'; key: string; root?: Task; count: number; isCollapsed: boolean; itemIds: string[] }
  | { kind: 'task'; task: Task; indent: number };

const INDENT_PX = 10; // per level below the root's direct children, the handoff's

/** The node's list with the tree toggle off (#34): every card where it sits today, unindented. */
export const flatRows = (tasks: readonly Task[]): NodeRow[] => tasks.map((task): NodeRow => ({ kind: 'task', task, indent: 0 }));

/** The node's list with the tree toggle on (#34): with no tree group, the cards as today; otherwise each group's header and, unless collapsed
 * in this node, its cards indented by depth. A collapsed group's cards are not rows at all, so the fold counts only what shows. */
export function nodeRows(all: readonly Task[], shown: readonly Task[], stage: string, collapsed: readonly string[]): NodeRow[] {
  const groups = groupTasks(all, shown);
  if (!groups.some((group) => group.root !== undefined)) return flatRows(shown);
  return groups.flatMap((group): NodeRow[] => {
    const key = collapseKey(stage, group.root);
    const isCollapsed = collapsed.includes(key);
    const header: NodeRow = { kind: 'group', key, root: group.root, count: group.tasks.length, isCollapsed, itemIds: group.tasks.map(({ task }) => idOf(task)) };
    if (isCollapsed) return [header];
    return [header, ...group.tasks.map(({ task, depth }): NodeRow => ({ kind: 'task', task, indent: Math.max(depth - 1, 0) * INDENT_PX }))];
  });
}

/** One segment of the details' tree bar (#36): a node below the root and its colour. */
export interface TreeSegment { id: string; tone: TaskState | 'done' }

/** The details' tree bar (#36): every node below the root, depth first in sub-issue order, each once, a child with no task included with nothing
 * under it, coloured by segmentTone with its own parent. The same nodes treeProgress counts, so the bar and the header's N agree. */
export function treeSegments(state: Pick<State, 'tasks'> & TaskStateInput, rootId: string, lastStage: string): TreeSegment[] {
  const seen = new Set<string>([rootId]); // a repeat ends the walk: GitHub forbids cycles, but the wire is not trusted (#28)
  const walk = (parent: Task): TreeSegment[] => (parent.item.children ?? []).flatMap((childId) => {
    if (seen.has(childId)) return [];
    seen.add(childId);
    const own: TreeSegment = { id: childId, tone: segmentTone(state, parent, childId, lastStage) };
    const child = state.tasks.find((task) => idOf(task) === childId);
    return child === undefined ? [own] : [own, ...walk(child)];
  });
  const root = state.tasks.find((task) => idOf(task) === rootId);
  return root === undefined ? [] : walk(root);
}

/** A row of the details' outline (#36). */
export interface OutlineRow { task: Task; depth: number; hasChildren: boolean; isCollapsed: boolean }

/** The details' outline (#36): the root and its descendant tasks in tree order, minus every task under a collapsed parent. A child with no task
 * has no row: it has no details to open. A stale id in `collapsed` matches no task and hides nothing. */
export function outlineRows(tasks: readonly Task[], rootId: string, collapsed: readonly string[]): OutlineRow[] {
  const root = tasks.find((task) => idOf(task) === rootId);
  if (root === undefined) return [];
  const members = [root, ...descendants(tasks, rootId)];
  const shut = members.filter((task) => collapsed.includes(idOf(task)));
  const hidden = new Set(shut.flatMap((task) => descendants(tasks, idOf(task)).map(idOf)));
  return members.filter((task) => !hidden.has(idOf(task))).map((task): OutlineRow => {
    const hasChildren = descendants(tasks, idOf(task)).length > 0;
    return { task, depth: depthOf(tasks, idOf(task)), hasChildren, isCollapsed: hasChildren && collapsed.includes(idOf(task)) };
  });
}
