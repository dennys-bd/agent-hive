import type { GhItemNode } from './github-queries.js';

// A Project's tree (#211, #28): what the poll groups and links its items by. Its own file since #190, so github.ts stays under 400 lines

export const statusOf = (item: GhItemNode): string | undefined => item.fieldValueByName?.name;
const subIssueIds = (item: GhItemNode): string[] => (item.content?.subIssues?.nodes ?? []).map((n) => n.id);

/** The items in source order with each epic's sub-issues moved right after it, in the epic's own sub-issue order, depth first; only
 * children in the epic's Status column follow it. Items with no epic above them in their column keep their relative source order (#211). */
export function groupUnderEpics(items: GhItemNode[]): GhItemNode[] {
  const byId = new Map(items.flatMap<[string, GhItemNode]>((item) => (item.content?.id ? [[item.content.id, item]] : [])));
  const parentOf = new Map<GhItemNode, GhItemNode>(); // GitHub gives an issue one parent at most; "first in source order" only makes this total
  for (const epic of items) {
    for (const id of subIssueIds(epic)) {
      const child = byId.get(id);
      if (child && child !== epic && !parentOf.has(child) && statusOf(child) === statusOf(epic)) parentOf.set(child, epic);
    }
  }
  const placed = new Set<GhItemNode>(); // a cycle or a duplicate can neither loop nor place a task twice
  const walk = (item: GhItemNode): GhItemNode[] => {
    if (placed.has(item)) return [];
    placed.add(item);
    const children = subIssueIds(item).flatMap((id) => {
      const child = byId.get(id);
      return child && parentOf.get(child) === item ? [child] : [];
    });
    return [item, ...children.flatMap((child) => walk(child))];
  };
  const roots = items.filter((item) => !parentOf.has(item));
  return [...roots, ...items].flatMap((item) => walk(item)); // a cycle leaves its items rootless: they come last, in source order
}

/** An item's place in its tree (#28): its parent's and its children's project item ids, and which of the children GitHub has closed. */
export interface TreeLinks { parent?: string; children: string[]; closedChildren: string[] }

/** Each node's tree links over a whole listing (#28). Unlike groupUnderEpics the Status column is ignored: a tree spans stages. A sub-issue
 * with no item is left out; the node itself and repeats are skipped, so a cycle or a duplicate on the wire places nothing twice. */
export function treeLinks(nodes: GhItemNode[]): Map<string, TreeLinks> {
  const itemOf = new Map<string, string>(); // issue node id → project item id
  for (const node of nodes) {
    const issueId = node.content?.id;
    if (issueId !== undefined && !itemOf.has(issueId)) itemOf.set(issueId, node.id);
  }
  const parents = new Map<string, string>(); // GitHub gives an issue one parent at most; "first in listing order" only makes this total
  const own = nodes.map((node): [string, TreeLinks] => {
    const children: string[] = [];
    const closedChildren: string[] = [];
    for (const sub of node.content?.subIssues?.nodes ?? []) {
      const child = itemOf.get(sub.id);
      if (child === undefined || child === node.id || children.includes(child)) continue;
      children.push(child);
      if (sub.state === 'CLOSED') closedChildren.push(child);
      if (!parents.has(child)) parents.set(child, node.id);
    }
    return [node.id, { children, closedChildren }];
  });
  return new Map(own.map(([id, links]): [string, TreeLinks] => {
    const parent = parents.get(id);
    return [id, parent === undefined ? links : { parent, ...links }];
  }));
}
