// The tree of one list of the table's rows (#584): a row nests under its parent when the parent is in the same list, any depth; every other
// row is a root. One pure helper, reused by the repository list (#585).
import { flowOf } from '../../flows.js';
import type { Flow, ProjectItem, ProjectView } from '../../types.js';

/** One visible line: the row, how deep it nests and how many of its children sit in the same list (a parent nests only with one, decision 10). */
export interface TreeRow { item: ProjectItem; depth: number; childCount: number }

const LOCAL = /^local:(\d+)$/;

// What a child's parent number names (#582): n of a hive row's local:<n> (its id is HIVE-n), else the source row's issue number
const keyOf = (item: ProjectItem): string => LOCAL.exec(item.itemId)?.[1] ?? item.id;

// Each row's parent in the list, by itemId. A row whose parent is not in the list, is itself, or whose chain of parents comes back to it
// (bad data, decision 5) has none: it is a root, and the loop below never runs forever
function parentsIn(items: readonly ProjectItem[]): ReadonlyMap<string, string> {
  const byKey = new Map(items.map((i) => [keyOf(i), i.itemId]));
  const links = new Map(items.flatMap((i): [string, string][] => {
    const parent = i.parent === undefined ? undefined : byKey.get(String(i.parent));
    return parent === undefined || parent === i.itemId ? [] : [[i.itemId, parent]];
  }));
  const inCycle = (id: string): boolean => {
    const seen = new Set<string>();
    for (let at = links.get(id); at !== undefined && !seen.has(at); at = links.get(at)) {
      if (at === id) return true;
      seen.add(at);
    }
    return false;
  };
  return new Map([...links].filter(([id]) => !inCycle(id)));
}

/** The visible lines of one list (decisions 1, 3, 5, 6): each child right after its parent, after its earlier siblings' subtrees, siblings in
 * the input's order; a parent not in `expanded` hides its whole subtree. */
export function treeRows(items: readonly ProjectItem[], expanded: ReadonlySet<string>): TreeRow[] {
  const parents = parentsIn(items);
  // ponytail: a scan of the list per row, O(n²); a Project read is capped, index the children by parent if a large one ever drags
  const childrenOf = (id: string | undefined): ProjectItem[] => items.filter((i) => parents.get(i.itemId) === id);
  const walk = (item: ProjectItem, depth: number): TreeRow[] => {
    const children = childrenOf(item.itemId);
    const line: TreeRow = { item, depth, childCount: children.length };
    return expanded.has(item.itemId) ? [line, ...children.flatMap((c) => walk(c, depth + 1))] : [line];
  };
  return childrenOf(undefined).flatMap((root) => walk(root, 0));
}

/** A parent's sub-issues: how many, and how many are done. */
export interface SubIssueCount { done: number; n: number }

const PROGRESS = /^(\d+)\/(\d+)$/; // GitHub's Sub-issues progress, done/total (ProjectItem.fields)

// Done (decision 9): a closed source issue; a hive task at the last stage of its flow, where a task ends. A hive task has no closedAt
function isDone(item: ProjectItem, flows: readonly Flow[]): boolean {
  if (item.closedAt !== undefined) return true;
  return LOCAL.test(item.itemId) && item.status !== undefined && flowOf(flows, item.status)?.stages.at(-1)?.name === item.status;
}

/** A parent's badge (decisions 8, 9): its own progress field's done/total, the field found by kind; with no value there, its children in the
 * whole view (not only its group) and the done ones. */
export function subIssueCount(parent: ProjectItem, view: Pick<ProjectView, 'fields' | 'items'>, flows: readonly Flow[]): SubIssueCount {
  const field = view.fields.find((f) => f.type === 'progress');
  const value = field !== undefined && Object.hasOwn(parent.fields, field.name) ? String(parent.fields[field.name]) : '';
  const progress = PROGRESS.exec(value);
  if (progress !== null) return { done: Number(progress[1]), n: Number(progress[2]) };
  const key = keyOf(parent);
  const children = view.items.filter((i) => i.itemId !== parent.itemId && i.parent !== undefined && String(i.parent) === key);
  return { done: children.filter((c) => isDone(c, flows)).length, n: children.length };
}
