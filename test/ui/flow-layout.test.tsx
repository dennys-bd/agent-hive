import { expect, test } from 'vitest';
import { DEPTH, END_SIZE, FORWARD_Y, GAP, hiddenBelow, layoutFlow, LOOP_RISE, MARGIN, maxNodeHeight, NODE_MIN, SPREAD, TOP_LOOPS } from '@/lib/flow-layout';

// The flowchart's geometry (#134, #887, #908), with no DOM.
const W = 190;
const NODES = [{ id: 'spec', height: 100 }, { id: 'build', height: 200 }, { id: 'checks', height: 80 }, { id: 'pr', height: 120 }];
const edge = (id: string, from: string, to: string, automatic = true) => ({ id, from, to, automatic });
const x = (i: number): number => MARGIN + i * (W + GAP);
const mid = (i: number): number => x(i) + W / 2;
const first = (path: string): number => Number(path.split(' ')[1]);
const last = (path: string): number => Number(path.split(' ').at(-2));

test('with neither a level nor a loop the row starts at MARGIN: nodes in order, GAP apart, top-aligned; the layout is as tall as its tallest node (#134, #887, #908)', () => {
  const layout = layoutFlow(NODES, [], W);
  expect([layout.top, layout.levels]).toEqual([MARGIN, 0]);
  expect(layout.nodes.map((n) => [n.id, n.x, n.y])).toEqual([['spec', x(0), MARGIN], ['build', x(1), MARGIN], ['checks', x(2), MARGIN], ['pr', x(3), MARGIN]]);
  expect(layout.width).toBe(x(3) + W + MARGIN);
  expect(layout.height).toBe(MARGIN + 200 + MARGIN);
});

test('a neighbour arrow is straight at top + FORWARD_Y whatever the node heights, its pill on it, solid even when automatic (#134, #908)', () => {
  const [e] = layoutFlow(NODES, [edge('f', 'spec', 'build')], W).edges;
  const y = MARGIN + FORWARD_Y;
  expect(e).toEqual({ id: 'f', kind: 'forward', path: `M ${x(0) + W} ${y} L ${x(1)} ${y}`, label: { x: x(0) + W + GAP / 2, y }, dashed: false });
});

test('a back edge leaves the source\'s top, runs on its level above the row and drops to the target\'s top, its pill on the level; dashed when automatic (#908)', () => {
  const layout = layoutFlow(NODES, [edge('back', 'checks', 'build')], W);
  const top = DEPTH + MARGIN;
  const level = top - DEPTH;
  const [xa, xb] = [mid(2), mid(1)];
  expect([layout.top, layout.levels]).toEqual([top, 1]);
  expect(layout.edges).toEqual([{
    id: 'back', kind: 'above', dashed: true, label: { x: (xa + xb) / 2, y: level },
    path: `M ${xa} ${top} L ${xa} ${level + 8} Q ${xa} ${level} ${xa - 8} ${level} L ${xb + 8} ${level} Q ${xb} ${level} ${xb} ${level + 8} L ${xb} ${top}`,
  }]);
  const [skip] = layoutFlow(NODES, [edge('skip', 'spec', 'checks')], W).edges;
  expect([skip.kind, skip.dashed]).toEqual(['above', false]); // a forward skip runs above too, solid: it does not go back
});

test('overlapping arrows take two levels DEPTH apart, the shorter inside; disjoint ones share one; two touching one node take two (#908)', () => {
  const overlapping = layoutFlow(NODES, [edge('fb', 'pr', 'build', false), edge('back', 'checks', 'build')], W);
  expect([overlapping.levels, overlapping.top]).toEqual([2, 2 * DEPTH + MARGIN]);
  const [fb, back] = overlapping.edges;
  expect([back.label.y, fb.label.y]).toEqual([overlapping.top - DEPTH, overlapping.top - 2 * DEPTH]);
  const disjoint = layoutFlow(NODES, [edge('a', 'build', 'spec'), edge('b', 'pr', 'checks')], W);
  expect(disjoint.levels).toBe(1);
  expect(disjoint.edges.map((e) => e.label.y)).toEqual([MARGIN, MARGIN]);
  const touching = layoutFlow(NODES, [edge('a', 'build', 'spec'), edge('b', 'checks', 'build')], W);
  expect(touching.levels).toBe(2);
  expect(touching.edges.map((e) => e.label.y)).toEqual([touching.top - DEPTH, touching.top - 2 * DEPTH]);
});

test('top is levels × DEPTH + MARGIN, TOP_LOOPS with only a loop, the larger of the two with both (#887, #908)', () => {
  const loop = edge('l', 'spec', 'spec', false);
  expect(layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build')], W).top).toBe(2 * DEPTH + MARGIN);
  expect(layoutFlow(NODES, [loop], W).top).toBe(TOP_LOOPS);
  expect(layoutFlow(NODES, [loop, edge('a', 'checks', 'build')], W).top).toBe(TOP_LOOPS); // one level, 52, leaves no room for the loop's pill
  expect(layoutFlow(NODES, [loop, edge('a', 'checks', 'build'), edge('b', 'pr', 'build')], W).top).toBe(2 * DEPTH + MARGIN);
});

test('arrows sharing a node\'s top arrive SPREAD apart around its centre (#134, #908)', () => {
  const layout = layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build', false)], W);
  expect([last(layout.edges[0].path), last(layout.edges[1].path)]).toEqual([mid(1) - SPREAD / 2, mid(1) + SPREAD / 2]);
  expect(first(layout.edges[0].path)).toBe(mid(2));
});

test('a loop moves the row down to TOP_LOOPS and arcs above its own node with its pill over it; an edge naming an unknown node is left out (#134, #887)', () => {
  const layout = layoutFlow(NODES, [edge('l', 'spec', 'spec', false), edge('x', 'spec', 'gone')], W);
  expect(layout.top).toBe(TOP_LOOPS);
  expect(layout.nodes.every((n) => n.y === TOP_LOOPS)).toBe(true);
  expect(layout.edges).toHaveLength(1);
  const [l] = layout.edges;
  expect([l.kind, l.dashed, l.label]).toEqual(['loop', false, { x: x(0) + W / 2, y: TOP_LOOPS - LOOP_RISE * 0.75 }]);
  expect(l.path.startsWith(`M ${x(0) + W * 0.3} ${TOP_LOOPS} C`)).toBe(true);
});

test('a loop on an unknown node is left out and leaves no room above the row (#887)', () => {
  const layout = layoutFlow(NODES, [edge('g', 'gone', 'gone')], W);
  expect([layout.top, layout.edges]).toEqual([MARGIN, []]);
});

test('the end circle is placed only with { end: true }: after the last node, centred on top + FORWARD_Y, the neighbour arrow ending on its left side; without it edges to END are left out (#908)', () => {
  const edges = [edge('e', 'pr', 'end', false)];
  const plain = layoutFlow(NODES, edges, W);
  expect([plain.end, plain.edges]).toEqual([undefined, []]);
  const settings = layoutFlow(NODES, edges, W, { end: true });
  const y = MARGIN + FORWARD_Y;
  expect(settings.end).toEqual({ id: 'end', x: x(4), y: y - END_SIZE / 2, width: END_SIZE, height: END_SIZE });
  expect(settings.edges[0].path).toBe(`M ${x(3) + W} ${y} L ${x(4)} ${y}`);
  expect(settings.width).toBe(x(4) + END_SIZE + MARGIN);
});

test('maxNodeHeight is the viewport less top and MARGIN, never under NODE_MIN; hiddenBelow counts the tasks past the fold (#134, #908)', () => {
  const twoLevels = layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build', false)], W);
  const looped = layoutFlow(NODES, [edge('l', 'spec', 'spec')], W);
  expect(maxNodeHeight(800, twoLevels)).toBe(800 - (2 * DEPTH + MARGIN) - MARGIN);
  expect(maxNodeHeight(800, looped)).toBe(800 - TOP_LOOPS - MARGIN);
  expect(maxNodeHeight(200, twoLevels)).toBe(NODE_MIN);
  expect(hiddenBelow(600, 300, 0, 10)).toBe(5);
  expect(hiddenBelow(600, 300, 300, 10)).toBe(0);
  expect(hiddenBelow(300, 300, 0, 5)).toBe(0);
});
