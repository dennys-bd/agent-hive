import { END } from '../../types.js';
import type { Loops } from './flow-view.js';

// The flowchart's geometry (#134, #908): one row of nodes in the stages' order, top-aligned. Forward arrows between neighbours run straight on
// the node header's line; every other arrow (back edges, forward skips) runs above the row on a level, levels shared by arrows that do not
// overlap; loops arc on their node's top; the end circle follows the last node only where asked (Settings). Pure and DOM-free: no arrow reads a
// node's height, which sets only the layout's own height. ponytail: one row, hand-written; elkjs replaces it when parallel stages or several rows arrive.

export const GAP = 72; // between two nodes: an arrow and its pill
export const GAP_ARROW = 32; // between two nodes joined only by arrows with no pill (#480): room for the line and its head
export const GAP_BARE = 16; // between two nodes with the loops hidden (#480): no arrow, no pill
export const DEPTH = 28; // between two levels above the row (#908)
export const SPREAD = 20; // arrows sharing a node's top, apart
export const END_SIZE = 30;
export const TOP_LOOPS = 56; // the least room above the row when a loop exists: its arc and its pill (#887)
export const FORWARD_Y = 16; // a neighbour arrow, under the row's top: the node header's line (#908)
export const LOOP_RISE = 36;
export const MARGIN = 24;
export const NODE_MIN = 160; // the least a node is given, however little room the viewport leaves
const CORNER = 8;

/** A segment's header line (#914): its top, in `count` equal segments of a box `height` tall, plus FORWARD_Y, from the box's top. */
export const segmentLine = (height: number, count: number, index: number): number => (index * height) / count + FORWARD_Y;

/** exit: the y offset from the node's top where its forward arrow leaves (#914); absent reads FORWARD_Y. */
export interface LayoutNode { id: string; width: number; height: number; exit?: number }
/** #914: the two segments of one strip an arrow joins, and how many segments the strip has. */
export interface Segments { from: number; to: number; count: number }
// unlabelled: carries no pill (#480); feedback: never inner by isInner (#576); inner: drawnEdgesOf's mark (#914), inner whatever isInner says;
// segments: an arrow between two segments of one strip (#914)
export interface LayoutEdge { id: string; from: string; to: string; automatic: boolean; unlabelled?: boolean; feedback?: boolean; inner?: boolean; segments?: Segments }
export interface LayoutOptions { end?: boolean; loops?: Loops } // end: the end circle, Settings only (#908); loops (#576): absent reads 'all'; 'none' draws no arrow (#909, #480)
export interface Box { id: string; x: number; y: number; width: number; height: number }
export type EdgeKind = 'forward' | 'above' | 'loop';
export interface Routed { id: string; kind: EdgeKind; path: string; label: { x: number; y: number }; dashed: boolean }
export interface Layout { nodes: Box[]; end?: Box; edges: Routed[]; width: number; height: number; levels: number; top: number }

interface Span extends LayoutEdge { i: number; j: number }
interface Placed extends Span { a: Box; b: Box; exit: number }

const bottom = (b: Box): number => b.y + b.height;
const centre = (b: Box): number => b.x + b.width / 2;
/** #576 decision 1: neighbours in the row, forward or back, and never feedback. */
export const isInner = (i: number, j: number, feedback: boolean): boolean => !feedback && Math.abs(i - j) === 1;
const kindOf = (i: number, j: number): EdgeKind => (i === j ? 'loop' : j === i + 1 ? 'forward' : 'above');
const range = (e: Span): [number, number] => [Math.min(e.i, e.j), Math.max(e.i, e.j)];

// The end circle sits after the row, centred on the neighbour arrows' line
const endBox = (x: number, top: number): Box => ({ id: END, x, y: top + FORWARD_Y - END_SIZE / 2, width: END_SIZE, height: END_SIZE });

// The room before each slot, the end circle's last (#480): none before the first; GAP_BARE with the loops hidden; GAP_ARROW when the arrows
// into the slot from the one before all go without a pill, so the default path packs tight; GAP when one carries a pill or none says, as in
// Settings, where every arrow has one
function gapsOf(count: number, spans: readonly Span[], bare: boolean): number[] {
  return Array.from({ length: count + 1 }, (_, k) => {
    if (k === 0) return 0;
    if (bare) return GAP_BARE;
    const into = spans.filter((e) => e.i === k - 1 && e.j === k);
    return into.length > 0 && into.every((e) => e.unlabelled === true) ? GAP_ARROW : GAP;
  });
}

const sum = (values: readonly number[]): number => values.reduce((a, v) => a + v, 0);

// Each slot's x, the end circle's last: the widths before it and the gaps up to it (#914: every node its own width)
const xsOf = (widths: readonly number[], gaps: readonly number[]): number[] =>
  gaps.map((_, i) => MARGIN + sum(widths.slice(0, i)) + sum(gaps.slice(0, i + 1)));

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

// Straight on the header's line; from a source whose exit sits lower (a merged strip's last segment, #914), out at the exit and up the gap's
// middle to the target's line, the pill on the rise
function forward(e: Placed, dashed: boolean, top: number): Routed {
  const [x1, x2, y1, y2] = [e.a.x + e.a.width, e.b.x, top + e.exit, top + FORWARD_Y];
  if (y1 === y2) return { id: e.id, kind: 'forward', path: `M ${x1} ${y2} L ${x2} ${y2}`, label: { x: (x1 + x2) / 2, y: y2 }, dashed };
  const xm = (x1 + x2) / 2;
  const path = `M ${x1} ${y1} L ${xm - CORNER} ${y1} Q ${xm} ${y1} ${xm} ${y1 - CORNER} L ${xm} ${y2 + CORNER} Q ${xm} ${y2} ${xm + CORNER} ${y2} L ${x2} ${y2}`;
  return { id: e.id, kind: 'forward', path, label: { x: xm, y: (y1 + y2) / 2 }, dashed };
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

/** The chart (#134, #908): `nodes` in the stages' order, each as wide and as tall as given (a node's `exit` moves its forward arrow down, #914); `edges` between their ids or to END, which
 * only `{ end: true }` draws. An edge naming an unknown node is left out. Dashed: an automatic arrow that goes back. With `{ loops: 'none' }`
 * (#909, #480) no arrow is drawn, so the row starts at the margin and the nodes sit GAP_BARE apart, with no pill to make room for; with them
 * on, two nodes whose arrows all go `unlabelled` sit GAP_ARROW apart. With { loops: 'inner' } only isInner's arrows are drawn (#576). */
export function layoutFlow(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: LayoutOptions = {}): Layout {
  const hasEnd = options.end === true && edges.some((e) => e.to === END);
  const all = spansOf(nodes, edges, hasEnd);
  const loops = options.loops ?? 'all';
  const bare = loops === 'none';
  // #576 decision 2: só internas drops the outer spans before levels and offsets, so the room above the row shrinks with them; END sits after the
  // last node, which isInner alone would call a neighbour, and decision 1 calls an arrow to end outer
  const drawn = loops === 'inner' ? all.filter((e) => e.to !== END && isInner(e.i, e.j, e.feedback === true)) : all;
  const spans = bare ? [] : drawn;
  const xs = xsOf(nodes.map((n) => n.width), gapsOf(nodes.length, drawn, bare));
  const levels = levelsOf(spans.filter((e) => kindOf(e.i, e.j) === 'above'));
  const count = Math.max(0, ...levels.values());
  // The room above the row holds the levels, the outermost at MARGIN, and a loop's arc and pill (#887): with neither the row starts at the margin
  const top = Math.max(count * DEPTH + MARGIN, spans.some((e) => e.i === e.j) ? TOP_LOOPS : MARGIN);
  const placed = nodes.map((n, i): Box => ({ id: n.id, x: xs[i], y: top, width: n.width, height: n.height }));
  const end = hasEnd ? endBox(xs[nodes.length], top) : undefined;
  const boxes = end === undefined ? placed : [...placed, end];
  const known = spans.map((e): Placed => ({ ...e, a: boxes[e.i], b: boxes[e.j], exit: nodes.at(e.i)?.exit ?? FORWARD_Y }));
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
