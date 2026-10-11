// The problems a decomposition's nodes can have (#865), past the file's own syntax: the ids and their tree, what a leaf and an inner node
// may hold, the contracts' shape and the Blocked by edges. GitHub's limits are checked here, so a write never fails halfway on one. Pure.
import { DECOMPOSITION_LABEL_MAX } from './conventions.js';
import type { DecompositionNode, DecompositionProblem } from './types.js';

export const CONTRACT_ID = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
export const TITLE_MAX = 200; // as createEvent's title
const DEPTH_MAX = 8; // GitHub nests sub-issues 8 levels below the root
const CHILDREN_MAX = 100; // GitHub's sub-issues per parent
export const NODES_MAX = 300; // one write stays far below GitHub's secondary rate limits
export const BODY_MAX = 65_536; // GitHub's limit on an issue body or a comment

/** Where a node's parts sit in the file: the problems' lines. */
export type NodeLines = Partial<Record<'delivers' | 'consumes' | 'blockedBy' | 'touches' | 'design' | 'openPoints' | 'criteria', number>>;
/** A node as the parser read it: the node, its heading's line and its parts' lines. */
export interface ParsedNode { node: DecompositionNode; line: number; at: NodeLines }

/** A node's parent id; '' for a top-level node, whose parent is the goal (#865). */
export const parentOf = (id: string): string => id.split('.').slice(0, -1).join('.');
/** Whether `ancestor` holds `id` somewhere below it (#865, #936). */
export const isAncestor = (ancestor: string, id: string): boolean => id.startsWith(`${ancestor}.`);

type Found = [message: string | false, line: number | undefined];
const kept = (found: Found[], fallback: number): DecompositionProblem[] =>
  found.flatMap(([message, line]) => (message === false ? [] : [{ line: line ?? fallback, message }]));

// The ids, the depth, the fan-out, the title, the scope, and what a leaf and an inner node may hold. A node is inner when another's id
// has it as its parent; Blocked by and the contracts play no part in it
function shapeProblems(parsed: ParsedNode[]): DecompositionProblem[] {
  const ids = parsed.map((p) => p.node.id);
  const inner = new Set(ids.map(parentOf));
  const children = new Map<string, number>();
  return parsed.flatMap(({ node, line, at }, i) => {
    const parent = parentOf(node.id);
    const count = (children.get(parent) ?? 0) + 1;
    children.set(parent, count);
    const isInner = inner.has(node.id);
    return kept([
      [ids.indexOf(node.id) !== i && `duplicate id "${node.id}"`, line],
      [parent !== '' && !ids.includes(parent) && `parent "${parent}" is absent`, line],
      [parent !== '' && ids.indexOf(parent) > i && `"${node.id}" comes before its parent "${parent}"`, line], // #936: the write needs the parent's number first
      [node.id.split('.').length > DEPTH_MAX && `more than ${DEPTH_MAX} levels below the goal`, line],
      [count === CHILDREN_MAX + 1 && `more than ${CHILDREN_MAX} children under ${parent === '' ? 'the goal' : `"${parent}"`}`, line],
      [(node.title === '' || node.title.length > TITLE_MAX) && `the title must be 1 to ${TITLE_MAX} characters`, line],
      [node.scope === '' && 'no "### Scope"', line],
      [!isInner && node.criteria.length === 0 && 'a leaf needs "### Acceptance criteria"', line],
      [!isInner && at.design !== undefined && 'a leaf has no "### Design": its decisions are open points', at.design],
      [isInner && node.openPoints.length > 0 && 'a node with children has no "### Open points": a crossing decision belongs in its design', at.openPoints],
      [isInner && node.criteria.length > 0 && 'a node with children has no "### Acceptance criteria"', at.criteria],
      [isInner && at.touches !== undefined && 'a node with children has no "Touches:": only a leaf touches files', at.touches],
    ], line);
  });
}

// A parent with one child: that child is the parent's own work restated, so the parent stays a leaf and the goal needs no tree. Reported
// at the parent's heading, or the title's line for the goal
function singleChildProblems(parsed: ParsedNode[]): DecompositionProblem[] {
  const counts = new Map<string, number>();
  for (const { node } of parsed) counts.set(parentOf(node.id), (counts.get(parentOf(node.id)) ?? 0) + 1);
  const goal = counts.get('') === 1 ? [{ line: 1, message: 'the goal has a single node: split it into two or more, or the goal is a leaf itself' }] : [];
  const nodes = parsed.filter((p) => counts.get(p.node.id) === 1)
    .map((p) => ({ line: p.line, message: `"${p.node.id}" has a single child: split it into two or more, or keep it a leaf` }));
  return [...goal, ...nodes];
}

// Each contract id's shape, and one deliverer per contract: the Hive checks no more for now (the spec's out of scope)
function contractProblems(parsed: ParsedNode[]): DecompositionProblem[] {
  const deliverer = new Map<string, string>();
  return parsed.flatMap(({ node, line, at }) => {
    const malformed = (ids: string[], n?: number): Found[] => ids.filter((c) => !CONTRACT_ID.test(c)).map((c): Found => [`malformed contract id "${c}"`, n]);
    const twice = node.delivers.map((c): Found => {
      const first = deliverer.get(c);
      if (first === undefined) deliverer.set(c, node.id);
      return [first !== undefined && `"${c}" is already delivered by ${first}`, at.delivers];
    });
    return kept([...malformed(node.delivers, at.delivers), ...malformed(node.consumes, at.consumes), ...twice], line);
  });
}

// A Touches: entry names a file or a folder of the repository (#936): never empty, absolute or climbing out of it
const isRepositoryPath = (path: string): boolean => path !== '' && !path.startsWith('/') && !path.split('/').includes('..');

function touchProblems(parsed: ParsedNode[]): DecompositionProblem[] {
  return parsed.flatMap(({ node, line, at }) =>
    kept(node.touches.filter((path) => !isRepositoryPath(path)).map((path): Found => [`"${path}" in "Touches:" must be a relative path without ".."`, at.touches]), line));
}

/** The file's `Label:` (#936): GitHub's limit on a label's name. Absent is no label, never a problem. */
export function labelProblems(label: string | undefined, line: number): DecompositionProblem[] {
  if (label === undefined || (label.length >= 1 && label.length <= DECOMPOSITION_LABEL_MAX)) return [];
  return [{ line, message: `the label must be 1 to ${DECOMPOSITION_LABEL_MAX} characters` }];
}

// Why a Blocked by edge cannot be, or undefined when it can: GitHub would hold an ancestor or a descendant as a blocker, yet the tree
// already orders them
function edgeProblem(ids: ReadonlySet<string>, id: string, blocker: string): string | undefined {
  if (!ids.has(blocker)) return `blocked by "${blocker}", which is no node`;
  if (blocker === id) return 'blocked by itself';
  if (isAncestor(blocker, id)) return `blocked by its ancestor "${blocker}"`;
  return isAncestor(id, blocker) ? `blocked by its descendant "${blocker}"` : undefined;
}

// The nodes whose Blocked by closes a cycle: a depth-first walk over the valid edges, each closing node named once
function cycleProblems(parsed: ParsedNode[], ids: ReadonlySet<string>): DecompositionProblem[] {
  const edges = new Map(parsed.map((p) => [p.node.id, p.node.blockedBy.filter((b) => edgeProblem(ids, p.node.id, b) === undefined)]));
  const seen = new Map<string, 'open' | 'done'>();
  const closing = new Set<string>();
  const visit = (id: string): void => {
    seen.set(id, 'open');
    for (const blocker of edges.get(id) ?? []) {
      if (seen.get(blocker) === 'open') closing.add(id);
      else if (!seen.has(blocker)) visit(blocker);
    }
    seen.set(id, 'done');
  };
  for (const id of edges.keys()) if (!seen.has(id)) visit(id);
  return parsed.filter((p) => closing.has(p.node.id)).map((p) => ({ line: p.at.blockedBy ?? p.line, message: 'this "Blocked by:" closes a cycle' }));
}

function blockerProblems(parsed: ParsedNode[]): DecompositionProblem[] {
  const ids = new Set(parsed.map((p) => p.node.id));
  const direct = parsed.flatMap(({ node, line, at }) => kept(node.blockedBy.map((b): Found => [edgeProblem(ids, node.id, b) ?? false, at.blockedBy]), line));
  return [...direct, ...cycleProblems(parsed, ids)];
}

/** Every problem of the nodes (#865), unsorted: the parser sorts them by line with its own. No node at all is one problem. */
export function checkNodes(parsed: ParsedNode[]): DecompositionProblem[] {
  if (parsed.length === 0) return [{ line: 1, message: 'no nodes: the file has no "## <id> <title>" heading' }];
  const over = parsed.length > NODES_MAX ? [{ line: parsed[NODES_MAX].line, message: `more than ${NODES_MAX} nodes` }] : [];
  return [...over, ...shapeProblems(parsed), ...singleChildProblems(parsed), ...contractProblems(parsed), ...blockerProblems(parsed), ...touchProblems(parsed)];
}
