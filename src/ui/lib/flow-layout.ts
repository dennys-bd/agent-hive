import { END } from '../../types.js';

// The flowchart's geometry (#134, #908): one row of nodes in the stages' order, top-aligned. Forward arrows between neighbours run straight on
// the node header's line; every other arrow (back edges, forward skips) runs above the row on a level, levels shared by arrows that do not
// overlap; loops arc on their node's top; the end circle follows the last node only where asked (Settings). Pure and DOM-free: no arrow reads a
// node's height, which sets only the layout's own height. ponytail: one row, hand-written; elkjs replaces it when parallel stages or several rows arrive.

export const GAP = 72; // between two nodes: an arrow and its pill
export const DEPTH = 28; // between two levels above the row (#908)
export const SPREAD = 20; // arrows sharing a node's top, apart
export const END_SIZE = 30;
export const TOP_LOOPS = 56; // the least room above the row when a loop exists: its arc and its pill (#887)
export const FORWARD_Y = 16; // a neighbour arrow, under the row's top: the node header's line (#908)
export const LOOP_RISE = 36;
export const MARGIN = 24;
export const NODE_MIN = 160; // the least a node is given, however little room the viewport leaves
const CORNER = 8;

export interface LayoutNode { id: string; height: number }
export interface LayoutEdge { id: string; from: string; to: string; automatic: boolean }
export interface LayoutOptions { end?: boolean } // #908: the end circle, Settings only
export interface Box { id: string; x: number; y: number; width: number; height: number }
export type EdgeKind = 'forward' | 'above' | 'loop';
export interface Routed { id: string; kind: EdgeKind; path: string; label: { x: number; y: number }; dashed: boolean }
export interface Layout { nodes: Box[]; end?: Box; edges: Routed[]; width: number; height: number; levels: number; top: number }

interface Span extends LayoutEdge { i: number; j: number }
interface Placed extends Span { a: Box; b: Box }

const bottom = (b: Box): number => b.y + b.height;
const centre = (b: Box): number => b.x + b.width / 2;
const kindOf = (i: number, j: number): EdgeKind => (i === j ? 'loop' : j === i + 1 ? 'forward' : 'above');
const range = (e: Span): [number, number] => [Math.min(e.i, e.j), Math.max(e.i, e.j)];

// The end circle sits after the row, centred on the neighbour arrows' line
function endBox(count: number, width: number, top: number): Box {
  return { id: END, x: MARGIN + count * (width + GAP), y: top + FORWARD_Y - END_SIZE / 2, width: END_SIZE, height: END_SIZE };
}

// Each edge's node indices, the end circle's after the row. An edge naming an unknown node, or the end without its circle, is left out
function spansOf(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], hasEnd: boolean): Span[] {
  const index = new Map([...nodes.map((n) => n.id), ...(hasEnd ? [END] : [])].map((id, i) => [id, i]));
  return edges.flatMap((e): Span[] => {
    const [i, j] = [index.get(e.from), index.get(e.to)];
    return i === undefined || j === undefined ? [] : [{ ...e, i, j }];
  });
}

// Each arrow takes the lowest level whose arrows it does not overlap, the shortest span first, so an arrow over few nodes runs inside one over
// many. Spans are inclusive: two arrows touching one node never share a level, or one's vertical leg would cross the other's run (#908)
function levelsOf(above: readonly Span[]): Map<string, number> {
  const sorted = [...above].sort((p, q) => Math.abs(p.j - p.i) - Math.abs(q.j - q.i));
  const taken: { e: Span; level: number }[] = [];
  for (const e of sorted) {
    const [lo, hi] = range(e);
    const clashes = (level: number): boolean => taken.some((d) => d.level === level && range(d.e)[0] <= hi && lo <= range(d.e)[1]);
    let level = 1;
    while (clashes(level)) level += 1;
    taken.push({ e, level });
  }
  return new Map(taken.map(({ e, level }) => [e.id, level]));
}

// Where each arrow leaves or meets a node's top: SPREAD apart around its centre, in the edges' order
function offsetsOf(above: readonly Placed[]): Map<string, number> {
  const ends = above.flatMap((e) => [{ node: e.a.id, end: `${e.id}|from` }, { node: e.b.id, end: `${e.id}|to` }]);
  return new Map(ends.map(({ node, end }) => {
    const shared = ends.filter((o) => o.node === node);
    const at = shared.findIndex((o) => o.end === end);
    return [end, SPREAD * (at - (shared.length - 1) / 2)];
  }));
}

function forward(e: Placed, dashed: boolean, top: number): Routed {
  const y = top + FORWARD_Y;
  const from = e.a.x + e.a.width;
  return { id: e.id, kind: 'forward', path: `M ${from} ${y} L ${e.b.x} ${y}`, label: { x: (from + e.b.x) / 2, y }, dashed };
}

function loop(e: Placed, dashed: boolean, top: number): Routed {
  const [x1, x2] = [e.a.x + e.a.width * 0.3, e.a.x + e.a.width * 0.7];
  const peak = top - LOOP_RISE;
  return { id: e.id, kind: 'loop', path: `M ${x1} ${top} C ${x1} ${peak}, ${x2} ${peak}, ${x2} ${top}`, label: { x: centre(e.a), y: top - LOOP_RISE * 0.75 }, dashed };
}

// Up from the source's top to its level, across, down to the target's top: the tip lands on the top (#908)
function over(e: Placed, xa: number, xb: number, level: number, dashed: boolean): Routed {
  const sign = xb > xa ? 1 : -1;
  const path = `M ${xa} ${e.a.y} L ${xa} ${level + CORNER} Q ${xa} ${level} ${xa + sign * CORNER} ${level} L ${xb - sign * CORNER} ${level} Q ${xb} ${level} ${xb} ${level + CORNER} L ${xb} ${e.b.y}`;
  return { id: e.id, kind: 'above', path, label: { x: (xa + xb) / 2, y: level }, dashed };
}

/** The chart (#134, #908): `nodes` in the stages' order, each `nodeWidth` wide and as tall as given; `edges` between their ids or to END, which
 * only `{ end: true }` draws. An edge naming an unknown node is left out. Dashed: an automatic arrow that goes back. */
export function layoutFlow(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], nodeWidth: number, options: LayoutOptions = {}): Layout {
  const hasEnd = options.end === true && edges.some((e) => e.to === END);
  const spans = spansOf(nodes, edges, hasEnd);
  const levels = levelsOf(spans.filter((e) => kindOf(e.i, e.j) === 'above'));
  const count = Math.max(0, ...levels.values());
  // The room above the row holds the levels, the outermost at MARGIN, and a loop's arc and pill (#887): with neither the row starts at the margin
  const top = Math.max(count * DEPTH + MARGIN, spans.some((e) => e.i === e.j) ? TOP_LOOPS : MARGIN);
  const placed = nodes.map((n, i): Box => ({ id: n.id, x: MARGIN + i * (nodeWidth + GAP), y: top, width: nodeWidth, height: n.height }));
  const end = hasEnd ? endBox(placed.length, nodeWidth, top) : undefined;
  const boxes = end === undefined ? placed : [...placed, end];
  const known = spans.map((e): Placed => ({ ...e, a: boxes[e.i], b: boxes[e.j] }));
  const offsets = offsetsOf(known.filter((e) => kindOf(e.i, e.j) === 'above'));
  const routed = known.map((e): Routed => {
    const dashed = e.automatic && e.j < e.i;
    const kind = kindOf(e.i, e.j);
    if (kind === 'loop') return loop(e, dashed, top);
    if (kind === 'forward') return forward(e, dashed, top);
    const level = top - DEPTH * (levels.get(e.id) ?? 1);
    return over(e, centre(e.a) + (offsets.get(`${e.id}|from`) ?? 0), centre(e.b) + (offsets.get(`${e.id}|to`) ?? 0), level, dashed);
  });
  const right = boxes.at(-1);
  return {
    nodes: placed, ...(end === undefined ? {} : { end }), edges: routed, levels: count, top,
    width: (right === undefined ? MARGIN : right.x + right.width) + MARGIN, height: Math.max(top, ...boxes.map(bottom)) + MARGIN,
  };
}

/** The tallest a node may grow (#134, #908): the viewport less the room above the row and the bottom margin, never under NODE_MIN. */
export const maxNodeHeight = (viewport: number, layout: Pick<Layout, 'top'>): number => Math.max(NODE_MIN, viewport - layout.top - MARGIN);

/** How many tasks of a scrolling list sit below its fold (#134): the node's rola para ver N. */
export function hiddenBelow(scrollHeight: number, clientHeight: number, scrollTop: number, count: number): number {
  if (count === 0 || scrollHeight <= clientHeight + 1) return 0;
  return Math.min(count, Math.ceil((scrollHeight - scrollTop - clientHeight) / (scrollHeight / count)));
}
