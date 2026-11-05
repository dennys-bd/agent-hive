// The tree of one list of the table's rows (#584): a row nests under its parent when the parent is in the same list, any depth; every other
// row is a root. One pure helper, reused by the repository list (#585).
import type { ProjectItem } from '../../types.js';

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
