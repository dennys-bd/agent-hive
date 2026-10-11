// Two leaves of a decomposition that touch the same file or folder with nothing ordering them (#936): a warning in the confirm dialog, never
// a problem. Ordering or merging them is the user's call. Pure.
import { isAncestor, parentOf, type ParsedNode } from './decomposition-check.js';
import type { DecompositionProblem } from './types.js';

// The node and its ancestors up to the top level
const lineage = (id: string): string[] => (id === '' ? [] : [id, ...lineage(parentOf(id))]);

// Every node `id` waits for: the Blocked by of the node and of its ancestors, then, transitively, the same of every node reached, since a
// blocked node waits with everything under it
function waitsFor(id: string, blockers: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const blocker of lineage(next).flatMap((n) => blockers.get(n) ?? [])) {
      if (seen.has(blocker)) continue;
      seen.add(blocker);
      queue.push(blocker);
    }
  }
  return seen;
}

// a waits for b: one of its blockers is b, holds b, or sits under b
const waitsOn = (waits: ReadonlySet<string>, b: string): boolean => [...waits].some((w) => w === b || isAncestor(w, b) || isAncestor(b, w));

// Two paths overlap when equal, or when one is a folder holding the other
const overlaps = (a: string, b: string): boolean => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
const sharedPath = (a: string[], b: string[]): [string, string] | undefined =>
  a.flatMap((x) => b.filter((y) => overlaps(x, y)).map((y): [string, string] => [x, y]))[0];

/** One warning per pair of leaves whose Touches: overlap and that no Blocked by chain orders (#936), at the later leaf's Touches: line. */
export function overlapWarnings(parsed: ParsedNode[]): DecompositionProblem[] {
  const inner = new Set(parsed.map((p) => parentOf(p.node.id)));
  const leaves = parsed.filter((p) => !inner.has(p.node.id) && p.node.touches.length > 0);
  const blockers = new Map(parsed.map((p) => [p.node.id, p.node.blockedBy]));
  const waits = new Map(leaves.map((p) => [p.node.id, waitsFor(p.node.id, blockers)]));
  const ordered = (a: string, b: string): boolean => waitsOn(waits.get(a) ?? new Set(), b) || waitsOn(waits.get(b) ?? new Set(), a);
  return leaves.flatMap((later, i) => leaves.slice(0, i).flatMap((earlier) => {
    const shared = sharedPath(earlier.node.touches, later.node.touches);
    if (shared === undefined || ordered(earlier.node.id, later.node.id)) return [];
    const message = `"${earlier.node.id}" touches "${shared[0]}" and "${later.node.id}" touches "${shared[1]}", and no "Blocked by:" orders them`;
    return [{ line: later.at.touches ?? later.line, message }];
  }));
}
