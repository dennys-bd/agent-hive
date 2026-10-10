import { END } from '../../types.js';

// The flowchart's geometry (#134): one row of nodes in the stages' order, forward arrows between neighbours at mid-height, every other arrow
// below the row at a depth of its own, loops above, the end circle after the last node. Pure and DOM-free: the flow view hands it the nodes'
// measured heights, Settings fixed ones. ponytail: one row, hand-written; elkjs replaces it when parallel stages or several rows arrive.

export const GAP = 72; // between two nodes: an arrow and its pill
export const DEPTH = 46; // one level below the row per arrow that runs under it
export const SPREAD = 20; // arrows sharing a node's bottom, apart
export const END_SIZE = 30;
export const TOP = 56; // room above the row for the loops and their pills, only when a loop exists (#887)
export const LOOP_RISE = 36;
export const MARGIN = 24;
export const NODE_MIN = 160; // a node before it is measured, and the least the free space gives it
const CORNER = 8;

export interface LayoutNode { id: string; height: number }
export interface LayoutEdge { id: string; from: string; to: string; automatic: boolean }
export interface Box { id: string; x: number; y: number; width: number; height: number }
export type EdgeKind = 'forward' | 'below' | 'loop';
export interface Routed { id: string; kind: EdgeKind; path: string; label: { x: number; y: number }; dashed: boolean }
export interface Layout { nodes: Box[]; end?: Box; edges: Routed[]; width: number; height: number; depths: number; top: number }

interface Placed extends LayoutEdge { i: number; j: number; a: Box; b: Box }

const bottom = (b: Box): number => b.y + b.height;
const centre = (b: Box): number => b.x + b.width / 2;
const kindOf = (i: number, j: number): EdgeKind => (i === j ? 'loop' : j === i + 1 ? 'forward' : 'below');

// The end circle sits after the row, centred on the last node's mid-height
function endBox(count: number, width: number, last: Box | undefined, top: number): Box {
  const middle = top + (last?.height ?? END_SIZE) / 2;
  return { id: END, x: MARGIN + count * (width + GAP), y: middle - END_SIZE / 2, width: END_SIZE, height: END_SIZE };
}

// One level each, the shortest span first, so an arrow over few nodes runs inside one over many
function levelsOf(below: readonly Placed[]): Map<string, number> {
  const sorted = [...below].sort((p, q) => Math.abs(p.j - p.i) - Math.abs(q.j - q.i));
  return new Map(sorted.map((e, k) => [e.id, k + 1]));
}

// Where each arrow leaves or meets a node's bottom: SPREAD apart around its centre, in the edges' order
function offsetsOf(below: readonly Placed[]): Map<string, number> {
  const ends = below.flatMap((e) => [{ node: e.a.id, end: `${e.id}|from` }, { node: e.b.id, end: `${e.id}|to` }]);
  return new Map(ends.map(({ node, end }) => {
    const shared = ends.filter((o) => o.node === node);
    const at = shared.findIndex((o) => o.end === end);
    return [end, SPREAD * (at - (shared.length - 1) / 2)];
  }));
}

function forward(e: Placed, dashed: boolean, top: number): Routed {
  const y = e.b.id === END ? e.b.y + e.b.height / 2 : top + Math.min(e.a.height, e.b.height) / 2;
  const from = e.a.x + e.a.width;
  return { id: e.id, kind: 'forward', path: `M ${from} ${y} L ${e.b.x} ${y}`, label: { x: (from + e.b.x) / 2, y }, dashed };
}

function loop(e: Placed, dashed: boolean, top: number): Routed {
  const [x1, x2] = [e.a.x + e.a.width * 0.3, e.a.x + e.a.width * 0.7];
  const peak = top - LOOP_RISE;
  return { id: e.id, kind: 'loop', path: `M ${x1} ${top} C ${x1} ${peak}, ${x2} ${peak}, ${x2} ${top}`, label: { x: centre(e.a), y: top - LOOP_RISE * 0.75 }, dashed };
}

function under(e: Placed, xa: number, xb: number, depth: number, dashed: boolean): Routed {
  const sign = xb > xa ? 1 : -1;
  const path = `M ${xa} ${bottom(e.a)} L ${xa} ${depth - CORNER} Q ${xa} ${depth} ${xa + sign * CORNER} ${depth} L ${xb - sign * CORNER} ${depth} Q ${xb} ${depth} ${xb} ${depth - CORNER} L ${xb} ${bottom(e.b)}`;
  return { id: e.id, kind: 'below', path, label: { x: (xa + xb) / 2, y: depth }, dashed };
}

/** The chart (#134): `nodes` in the stages' order, each `nodeWidth` wide and as tall as given; `edges` between their ids or to END. An edge
 * naming an unknown node is left out. Dashed: an automatic arrow that goes back. */
export function layoutFlow(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], nodeWidth: number): Layout {
  const ids = new Set(nodes.map((n) => n.id));
  // The room above the row is for loops and their pills (#887): without one the row starts at the margin, no empty band over the chart
  const top = edges.some((e) => e.from === e.to && ids.has(e.from)) ? TOP : MARGIN;
  const placed = nodes.map((n, i): Box => ({ id: n.id, x: MARGIN + i * (nodeWidth + GAP), y: top, width: nodeWidth, height: n.height }));
  const end = edges.some((e) => e.to === END) ? endBox(placed.length, nodeWidth, placed.at(-1), top) : undefined;
  const boxes = end === undefined ? placed : [...placed, end];
  const index = new Map(boxes.map((b, i) => [b.id, i]));
  const known = edges.flatMap((e): Placed[] => {
    const [i, j] = [index.get(e.from), index.get(e.to)];
    return i === undefined || j === undefined ? [] : [{ ...e, i, j, a: boxes[i], b: boxes[j] }];
  });
  const below = known.filter((e) => kindOf(e.i, e.j) === 'below');
  const levels = levelsOf(below);
  const offsets = offsetsOf(below);
  const floor = (e: Placed): number => Math.max(...boxes.slice(Math.min(e.i, e.j), Math.max(e.i, e.j) + 1).map(bottom));
  const routed = known.map((e): Routed => {
    const dashed = e.automatic && e.j < e.i;
    const kind = kindOf(e.i, e.j);
    if (kind === 'loop') return loop(e, dashed, top);
    if (kind === 'forward') return forward(e, dashed, top);
    const depth = floor(e) + DEPTH * (levels.get(e.id) ?? 1);
    return under(e, centre(e.a) + (offsets.get(`${e.id}|from`) ?? 0), centre(e.b) + (offsets.get(`${e.id}|to`) ?? 0), depth, dashed);
  });
  const right = boxes.at(-1);
  const lowest = Math.max(top, ...boxes.map(bottom));
  return {
    nodes: placed, ...(end === undefined ? {} : { end }), edges: routed, depths: below.length, top,
    width: (right === undefined ? MARGIN : right.x + right.width) + MARGIN, height: lowest + DEPTH * below.length + MARGIN,
  };
}

/** The tallest a node may grow (#134): the viewport less the layout's room above the row (#887) and the arrows below it, never under NODE_MIN. */
export const maxNodeHeight = (viewport: number, layout: Pick<Layout, 'top' | 'depths'>): number => Math.max(NODE_MIN, viewport - layout.top - DEPTH * layout.depths - MARGIN);

/** How many tasks of a scrolling list sit below its fold (#134): the node's rola para ver N. */
export function hiddenBelow(scrollHeight: number, clientHeight: number, scrollTop: number, count: number): number {
  if (count === 0 || scrollHeight <= clientHeight + 1) return 0;
  return Math.min(count, Math.ceil((scrollHeight - scrollTop - clientHeight) / (scrollHeight / count)));
}
