import { expect, test } from 'vitest';
import { DEPTH, END_SIZE, FORWARD_Y, GAP, GAP_ARROW, GAP_BARE, hiddenBelow, isInner, isInnerEdge, layoutFlow, LOOP_RISE, MARGIN, maxNodeHeight, NODE_MIN, segmentLine, SIDE_STEP, SPREAD, TOP_LOOPS } from '@/lib/flow-layout';
import type { Loops } from '@/lib/flow-view';

// The flowchart's geometry (#134, #887, #908), with no DOM.
const W = 190;
const NODES = [{ id: 'spec', width: W, height: 100 }, { id: 'build', width: W, height: 200 }, { id: 'checks', width: W, height: 80 }, { id: 'pr', width: W, height: 120 }];
const edge = (id: string, from: string, to: string, automatic = true) => ({ id, from, to, automatic });
const x = (i: number): number => MARGIN + i * (W + GAP);
const mid = (i: number): number => x(i) + W / 2;
const first = (path: string): number => Number(path.split(' ')[1]);
const last = (path: string): number => Number(path.split(' ').at(-2));

test('with neither a level nor a loop the row starts at MARGIN: nodes in order, GAP apart, top-aligned; the layout is as tall as its tallest node (#134, #887, #908)', () => {
  const layout = layoutFlow(NODES, []);
  expect([layout.top, layout.levels]).toEqual([MARGIN, 0]);
  expect(layout.nodes.map((n) => [n.id, n.x, n.y])).toEqual([['spec', x(0), MARGIN], ['build', x(1), MARGIN], ['checks', x(2), MARGIN], ['pr', x(3), MARGIN]]);
  expect(layout.width).toBe(x(3) + W + MARGIN);
  expect(layout.height).toBe(MARGIN + 200 + MARGIN);
});

test('a neighbour arrow is straight at top + FORWARD_Y whatever the node heights, its pill on it, solid even when automatic (#134, #908)', () => {
  const [e] = layoutFlow(NODES, [edge('f', 'spec', 'build')]).edges;
  const y = MARGIN + FORWARD_Y;
  expect(e).toEqual({ id: 'f', kind: 'forward', path: `M ${x(0) + W} ${y} L ${x(1)} ${y}`, label: { x: x(0) + W + GAP / 2, y }, dashed: false });
});

test('a back edge leaves the source\'s top, runs on its level above the row and drops to the target\'s top, its pill on the level; dashed when automatic (#908)', () => {
  const layout = layoutFlow(NODES, [edge('back', 'checks', 'build')]);
  const top = DEPTH + MARGIN;
  const level = top - DEPTH;
  const [xa, xb] = [mid(2), mid(1)];
  expect([layout.top, layout.levels]).toEqual([top, 1]);
  expect(layout.edges).toEqual([{
    id: 'back', kind: 'above', dashed: true, label: { x: (xa + xb) / 2, y: level },
    path: `M ${xa} ${top} L ${xa} ${level + 8} Q ${xa} ${level} ${xa - 8} ${level} L ${xb + 8} ${level} Q ${xb} ${level} ${xb} ${level + 8} L ${xb} ${top}`,
  }]);
  const [skip] = layoutFlow(NODES, [edge('skip', 'spec', 'checks')]).edges;
  expect([skip.kind, skip.dashed]).toEqual(['above', false]); // a forward skip runs above too, solid: it does not go back
});

test('overlapping arrows take two levels DEPTH apart, the shorter inside; disjoint ones share one; two touching one node take two (#908)', () => {
  const overlapping = layoutFlow(NODES, [edge('fb', 'pr', 'build', false), edge('back', 'checks', 'build')]);
  expect([overlapping.levels, overlapping.top]).toEqual([2, 2 * DEPTH + MARGIN]);
  const [fb, back] = overlapping.edges;
  expect([back.label.y, fb.label.y]).toEqual([overlapping.top - DEPTH, overlapping.top - 2 * DEPTH]);
  const disjoint = layoutFlow(NODES, [edge('a', 'build', 'spec'), edge('b', 'pr', 'checks')]);
  expect(disjoint.levels).toBe(1);
  expect(disjoint.edges.map((e) => e.label.y)).toEqual([MARGIN, MARGIN]);
  const touching = layoutFlow(NODES, [edge('a', 'build', 'spec'), edge('b', 'checks', 'build')]);
  expect(touching.levels).toBe(2);
  expect(touching.edges.map((e) => e.label.y)).toEqual([touching.top - DEPTH, touching.top - 2 * DEPTH]);
});

test('top is levels × DEPTH + MARGIN, TOP_LOOPS with only a loop, the larger of the two with both (#887, #908)', () => {
  const loop = edge('l', 'spec', 'spec', false);
  expect(layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build')]).top).toBe(2 * DEPTH + MARGIN);
  expect(layoutFlow(NODES, [loop]).top).toBe(TOP_LOOPS);
  expect(layoutFlow(NODES, [loop, edge('a', 'checks', 'build')]).top).toBe(TOP_LOOPS); // one level, 52, leaves no room for the loop's pill
  expect(layoutFlow(NODES, [loop, edge('a', 'checks', 'build'), edge('b', 'pr', 'build')]).top).toBe(2 * DEPTH + MARGIN);
});

test('arrows sharing a node\'s top arrive SPREAD apart around its centre (#134, #908)', () => {
  const layout = layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build', false)]);
  expect([last(layout.edges[0].path), last(layout.edges[1].path)]).toEqual([mid(1) - SPREAD / 2, mid(1) + SPREAD / 2]);
  expect(first(layout.edges[0].path)).toBe(mid(2));
});

test('a loop moves the row down to TOP_LOOPS and arcs above its own node with its pill over it; an edge naming an unknown node is left out (#134, #887)', () => {
  const layout = layoutFlow(NODES, [edge('l', 'spec', 'spec', false), edge('x', 'spec', 'gone')]);
  expect(layout.top).toBe(TOP_LOOPS);
  expect(layout.nodes.every((n) => n.y === TOP_LOOPS)).toBe(true);
  expect(layout.edges).toHaveLength(1);
  const [l] = layout.edges;
  expect([l.kind, l.dashed, l.label]).toEqual(['loop', false, { x: x(0) + W / 2, y: TOP_LOOPS - LOOP_RISE * 0.75 }]);
  expect(l.path.startsWith(`M ${x(0) + W * 0.3} ${TOP_LOOPS} C`)).toBe(true);
});

test('a loop on an unknown node is left out and leaves no room above the row (#887)', () => {
  const layout = layoutFlow(NODES, [edge('g', 'gone', 'gone')]);
  expect([layout.top, layout.edges]).toEqual([MARGIN, []]);
});

test('the end circle is placed only with { end: true }: after the last node, centred on top + FORWARD_Y, the neighbour arrow ending on its left side; without it edges to END are left out (#908)', () => {
  const edges = [edge('e', 'pr', 'end', false)];
  const plain = layoutFlow(NODES, edges);
  expect([plain.end, plain.edges]).toEqual([undefined, []]);
  const settings = layoutFlow(NODES, edges, { end: true });
  const y = MARGIN + FORWARD_Y;
  expect(settings.end).toEqual({ id: 'end', x: x(4), y: y - END_SIZE / 2, width: END_SIZE, height: END_SIZE });
  expect(settings.edges[0].path).toBe(`M ${x(3) + W} ${y} L ${x(4)} ${y}`);
  expect(settings.width).toBe(x(4) + END_SIZE + MARGIN);
});

test('maxNodeHeight is the viewport less top and MARGIN, never under NODE_MIN; hiddenBelow counts the tasks past the fold (#134, #908)', () => {
  const twoLevels = layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build', false)]);
  const looped = layoutFlow(NODES, [edge('l', 'spec', 'spec')]);
  expect(maxNodeHeight(800, twoLevels)).toBe(800 - (2 * DEPTH + MARGIN) - MARGIN);
  expect(maxNodeHeight(800, looped)).toBe(800 - TOP_LOOPS - MARGIN);
  expect(maxNodeHeight(200, twoLevels)).toBe(NODE_MIN);
  expect(hiddenBelow(600, 300, 0, 10)).toBe(5);
  expect(hiddenBelow(600, 300, 300, 10)).toBe(0);
  expect(hiddenBelow(300, 300, 0, 5)).toBe(0);
});

test('with voltas none no arrow is drawn, not even to the next node, so no pill either; top falls to MARGIN and the nodes sit GAP_BARE apart (#909, #480)', () => {
  const edges = [edge('f', 'spec', 'build'), edge('b', 'checks', 'build'), edge('l', 'spec', 'spec'), edge('u', 'spec', 'checks'), edge('s', 'build', 'pr')];
  expect(layoutFlow(NODES, edges).edges.map((e) => e.id)).toEqual(['f', 'b', 'l', 'u', 's']);
  expect(layoutFlow(NODES, edges, { loops: 'all' })).toEqual(layoutFlow(NODES, edges)); // the default is loops on: today's output
  const hidden = layoutFlow(NODES, edges, { loops: 'none' });
  expect([hidden.edges, hidden.levels, hidden.top]).toEqual([[], 0, MARGIN]);
  expect(hidden.nodes.map((n) => [n.x, n.y])).toEqual(NODES.map((_, i) => [MARGIN + i * (W + GAP_BARE), MARGIN]));
  expect(hidden.width).toBe(MARGIN + 3 * (W + GAP_BARE) + W + MARGIN);
});

test('a neighbour arrow with no pill takes GAP_ARROW, one with a pill keeps GAP; edges that say nothing (Settings) keep GAP everywhere (#480)', () => {
  const edges = [{ ...edge('a', 'spec', 'build'), unlabelled: true }, edge('b', 'build', 'checks'), { ...edge('c', 'checks', 'pr'), unlabelled: true }, { ...edge('d', 'checks', 'pr'), unlabelled: true }];
  const layout = layoutFlow(NODES, edges);
  const xs = [MARGIN, MARGIN + W + GAP_ARROW, MARGIN + 2 * W + GAP_ARROW + GAP, MARGIN + 3 * W + 2 * GAP_ARROW + GAP];
  expect(layout.nodes.map((n) => n.x)).toEqual(xs);
  expect(layout.width).toBe(xs[3] + W + MARGIN);
  const [a] = layout.edges;
  expect(a.path).toBe(`M ${MARGIN + W} ${MARGIN + FORWARD_Y} L ${xs[1]} ${MARGIN + FORWARD_Y}`);
  const mixed = layoutFlow(NODES, [{ ...edge('a', 'spec', 'build'), unlabelled: true }, edge('a2', 'spec', 'build')]);
  expect(mixed.nodes[1].x).toBe(x(1)); // one of the two arrows carries a pill: the gap stays wide
  expect(layoutFlow(NODES, edges.map(({ id, from, to, automatic }) => ({ id, from, to, automatic }))).nodes.map((n) => n.x)).toEqual([0, 1, 2, 3].map(x));
});

test('isInner: neighbours forward and back; a loop, a skip and any feedback arrow are outer (#576)', () => {
  expect([isInner(1, 2, false), isInner(2, 1, false), isInner(1, 1, false), isInner(0, 2, false), isInner(1, 2, true)]).toEqual([true, true, false, false, false]);
});

test('loops inner keeps the neighbour arrows, forward and back; a forward skip, a back edge over a stage, a loop, an arrow to end and a neighbour feedback arrow go, and levels and top shrink with them (#576)', () => {
  const edges = [
    edge('f', 'spec', 'build'), edge('b', 'checks', 'build'), edge('u', 'spec', 'checks'), edge('o', 'pr', 'build'),
    edge('l', 'spec', 'spec'), edge('e', 'pr', 'end'), { ...edge('fb', 'build', 'checks'), feedback: true },
  ];
  const all = layoutFlow(NODES, edges, { end: true, loops: 'all' });
  expect(all.edges.map((e) => e.id)).toEqual(['f', 'b', 'u', 'o', 'l', 'e', 'fb']);
  expect([all.levels, all.top]).toEqual([3, 3 * DEPTH + MARGIN]);
  const inner = layoutFlow(NODES, edges, { end: true, loops: 'inner' });
  expect(inner.edges.map((e) => [e.id, e.kind])).toEqual([['f', 'forward'], ['b', 'above']]);
  expect([inner.levels, inner.top]).toEqual([1, DEPTH + MARGIN]);
  expect(layoutFlow(NODES, edges, { end: true })).toEqual(all); // absent reads all: Settings and the benchmark keep today's output
  const none = layoutFlow(NODES, edges, { end: true, loops: 'none' });
  expect([none.edges, none.levels, none.top]).toEqual([[], 0, MARGIN]);
  expect(none.nodes[1].x).toBe(MARGIN + W + GAP_BARE);
});

test('loops inner packs a pair by its drawn arrows: a dropped feedback pill beside an unlabelled one leaves GAP_ARROW (#576)', () => {
  const edges = [{ ...edge('d', 'build', 'checks'), unlabelled: true }, { ...edge('fb', 'build', 'checks'), feedback: true }];
  const gap = (loops: 'all' | 'inner'): number => { const { nodes } = layoutFlow(NODES, edges, { loops }); return nodes[2].x - nodes[1].x - W; };
  expect([gap('all'), gap('inner')]).toEqual([GAP, GAP_ARROW]);
});

// #914: a 40px strip between two nodes
const S = 40;
const MIXED = [{ id: 'a', width: W, height: 100 }, { id: 'strip', width: S, height: 300 }, { id: 'b', width: W, height: 100 }];

test('each node takes its own width: an x sums the widths and the #480 gaps before it (#914)', () => {
  const layout = layoutFlow(MIXED, [edge('in', 'a', 'strip'), { ...edge('out', 'strip', 'b'), unlabelled: true }]);
  expect(layout.nodes.map((n) => [n.x, n.width])).toEqual([[MARGIN, W], [MARGIN + W + GAP, S], [MARGIN + W + GAP + S + GAP_ARROW, W]]);
  expect(layout.width).toBe(MARGIN + 2 * W + S + GAP + GAP_ARROW + MARGIN);
});

test('a forward arrow leaves at its source\'s exit and bends up to the target\'s FORWARD_Y, its pill on the bend; no exit keeps the straight line (#914)', () => {
  const nodes = [{ id: 'strip', width: S, height: 300, exit: segmentLine(300, 3, 2) }, { id: 'b', width: W, height: 100 }];
  const [out] = layoutFlow(nodes, [edge('out', 'strip', 'b')]).edges;
  const [x1, x2] = [MARGIN + S, MARGIN + S + GAP];
  const xm = (x1 + x2) / 2;
  const [y1, y2] = [MARGIN + 200 + FORWARD_Y, MARGIN + FORWARD_Y];
  expect(out).toEqual({
    id: 'out', kind: 'forward', dashed: false, label: { x: xm, y: (y1 + y2) / 2 },
    path: `M ${x1} ${y1} L ${xm - 8} ${y1} Q ${xm} ${y1} ${xm} ${y1 - 8} L ${xm} ${y2 + 8} Q ${xm} ${y2} ${xm + 8} ${y2} L ${x2} ${y2}`,
  });
  const [straight] = layoutFlow([{ ...nodes[0], exit: undefined }, nodes[1]], [edge('out', 'strip', 'b')]).edges;
  expect(straight.path).toBe(`M ${x1} ${y2} L ${x2} ${y2}`);
});

test('segmentLine is a segment\'s header line: its top in equal segments, plus FORWARD_Y (#914)', () => {
  expect([segmentLine(300, 3, 0), segmentLine(300, 3, 1), segmentLine(300, 3, 2), segmentLine(240, 1, 0)]).toEqual([FORWARD_Y, 100 + FORWARD_Y, 200 + FORWARD_Y, FORWARD_Y]);
});

const side = (id: string, from: number, to: number, count = 3, extra: object = {}) => ({ ...edge(id, 'strip', 'strip'), inner: true, segments: { from, to, count }, ...extra });

test('an arrow between two segments of a strip is a side arc on its left, from the source segment\'s line to the target\'s, nested by span, dashed going up when automatic; it leaves the row\'s top alone (#914)', () => {
  const layout = layoutFlow(MIXED, [side('short', 0, 1, 3, { automatic: false }), side('long', 0, 2), side('back', 2, 1)]);
  const strip = layout.nodes[1];
  const line = (k: number): number => strip.y + segmentLine(strip.height, 3, k);
  const arc = (from: number, to: number, level: number): string => {
    const d = SIDE_STEP * level;
    return `M ${strip.x} ${line(from)} C ${strip.x - d} ${line(from)}, ${strip.x - d} ${line(to)}, ${strip.x} ${line(to)}`;
  };
  expect(layout.top).toBe(MARGIN);
  // short and back each span one segment but touch segment 1, so they take two levels; long spans two and goes outside both
  expect(layout.edges.map((e) => [e.id, e.kind, e.path, e.dashed])).toEqual([
    ['short', 'side', arc(0, 1, 1), false], ['long', 'side', arc(0, 2, 3), false], ['back', 'side', arc(2, 1, 2), true],
  ]);
  expect(layout.edges[0].label).toEqual({ x: strip.x - SIDE_STEP * 0.75, y: (line(0) + line(1)) / 2 });
});

test('a strip\'s side arcs take the room before it by #480\'s rules, as the first slot too; with the loops hidden they take none (#914)', () => {
  const arc = (unlabelled: boolean) => side('s', 0, 1, 2, { unlabelled });
  const first = [{ id: 'strip', width: S, height: 300 }, { id: 'b', width: W, height: 100 }];
  expect(layoutFlow(first, [arc(false)]).nodes[0].x).toBe(MARGIN + GAP);
  expect(layoutFlow(first, [arc(true)]).nodes[0].x).toBe(MARGIN + GAP_ARROW);
  expect(layoutFlow(first, [arc(false)], { loops: 'none' }).nodes[0].x).toBe(MARGIN);
  // the arrow in carries no pill, the arc does: the gap stays wide
  expect(layoutFlow(MIXED, [{ ...edge('in', 'a', 'strip'), unlabelled: true }, arc(false)]).nodes[1].x).toBe(MARGIN + W + GAP);
});

test('a side arc is inner by its mark, feedback too: kept under loops inner with the neighbour arrows, gone under none (#914)', () => {
  const edges = [edge('in', 'a', 'strip'), side('fb', 1, 0, 2, { feedback: true }), edge('skip', 'b', 'a')];
  const kinds = (loops: Loops) => layoutFlow(MIXED, edges, { loops }).edges.map((e) => [e.id, e.kind]);
  expect(kinds('all')).toEqual([['in', 'forward'], ['fb', 'side'], ['skip', 'above']]);
  expect(kinds('inner')).toEqual([['in', 'forward'], ['fb', 'side']]);
  expect(kinds('none')).toEqual([]);
  expect([isInnerEdge({ inner: true, feedback: true }, 3, 3), isInnerEdge({}, 1, 2), isInnerEdge({ feedback: true }, 1, 2)]).toEqual([true, true, false]);
});

test('no pill sits on a strip: the forward, above, loop and side pills around it all fall outside its box (#914)', () => {
  const nodes = [MIXED[0], { id: 'strip', width: S, height: 300, exit: segmentLine(300, 3, 2) }, MIXED[2]];
  const edges = [edge('in', 'a', 'strip'), edge('out', 'strip', 'b'), edge('over', 'b', 'a'), edge('back', 'b', 'strip'), edge('loop', 'strip', 'strip'), side('side', 2, 0)];
  const layout = layoutFlow(nodes, edges);
  const strip = layout.nodes[1];
  const isOn = ({ x, y }: { x: number; y: number }): boolean => x >= strip.x && x <= strip.x + strip.width && y >= strip.y && y <= strip.y + strip.height;
  expect(layout.edges).toHaveLength(6);
  expect(layout.edges.filter((e) => isOn(e.label)).map((e) => e.id)).toEqual([]);
});
