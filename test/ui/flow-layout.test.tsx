import { expect, test } from 'vitest';
import { DEPTH, END_SIZE, GAP, hiddenBelow, layoutFlow, LOOP_RISE, MARGIN, maxNodeHeight, NODE_MIN, SPREAD, TOP } from '@/lib/flow-layout';

// The flowchart's geometry (#134, #887), with no DOM.
const W = 190;
const NODES = [{ id: 'spec', height: 100 }, { id: 'build', height: 200 }, { id: 'checks', height: 80 }, { id: 'pr', height: 120 }];
const edge = (id: string, from: string, to: string, automatic = true) => ({ id, from, to, automatic });
const x = (i: number): number => MARGIN + i * (W + GAP);

test('without a loop the row starts at MARGIN: nodes in order, GAP apart and top-aligned; the end circle after the last, on its mid-height (#134, #887)', () => {
  const layout = layoutFlow(NODES, [edge('e', 'pr', 'end', false)], W);
  expect(layout.top).toBe(MARGIN);
  expect(layout.nodes.map((n) => [n.id, n.x, n.y])).toEqual([['spec', x(0), MARGIN], ['build', x(1), MARGIN], ['checks', x(2), MARGIN], ['pr', x(3), MARGIN]]);
  expect(layout.end).toEqual({ id: 'end', x: x(4), y: MARGIN + 60 - END_SIZE / 2, width: END_SIZE, height: END_SIZE });
  expect(layout.width).toBe(x(4) + END_SIZE + MARGIN);
  expect(layout.edges[0].kind).toBe('forward');
});

test('an adjacent forward arrow is straight at the lower mid-height of its two nodes, its pill on it, solid even when automatic (#134)', () => {
  const [e] = layoutFlow(NODES, [edge('f', 'spec', 'build')], W).edges;
  const y = MARGIN + 50;
  expect(e).toEqual({ id: 'f', kind: 'forward', path: `M ${x(0) + W} ${y} L ${x(1)} ${y}`, label: { x: x(0) + W + GAP / 2, y }, dashed: false });
});

test('back and non-adjacent arrows run below from the lowest bottom they span, one level each, the shorter inside; dashed only when automatic and going back (#134)', () => {
  const layout = layoutFlow(NODES, [edge('back', 'checks', 'build'), edge('skip', 'spec', 'checks', false), edge('fb', 'pr', 'build', false)], W);
  const [back, skip, fb] = layout.edges;
  expect([back.kind, skip.kind, fb.kind]).toEqual(['below', 'below', 'below']);
  expect([back.dashed, skip.dashed, fb.dashed]).toEqual([true, false, false]);
  const lowest = MARGIN + 200; // build's bottom, inside all three spans
  expect([back.label.y, skip.label.y, fb.label.y]).toEqual([lowest + DEPTH, lowest + 2 * DEPTH, lowest + 3 * DEPTH]);
  expect(layout.depths).toBe(3);
  expect(layout.height).toBe(lowest + 3 * DEPTH + MARGIN);
});

test('arrows sharing a node\'s bottom spread SPREAD apart around its centre (#134)', () => {
  const layout = layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build', false)], W);
  const first = (path: string): number => Number(path.split(' ')[1]);
  const last = (path: string): number => Number(path.split(' ').at(-2));
  const centre = x(1) + W / 2;
  expect([last(layout.edges[0].path), last(layout.edges[1].path)]).toEqual([centre - SPREAD / 2, centre + SPREAD / 2]);
  expect(first(layout.edges[0].path)).toBe(x(2) + W / 2);
});

test('a loop moves the row down to TOP and arcs above its own node with its pill over it; an edge naming an unknown node is left out (#134, #887)', () => {
  const layout = layoutFlow(NODES, [edge('l', 'spec', 'spec', false), edge('x', 'spec', 'gone')], W);
  expect(layout.top).toBe(TOP);
  expect(layout.nodes.every((n) => n.y === TOP)).toBe(true);
  expect(layout.edges).toHaveLength(1);
  const [l] = layout.edges;
  expect([l.kind, l.dashed, l.label]).toEqual(['loop', false, { x: x(0) + W / 2, y: TOP - LOOP_RISE * 0.75 }]);
  expect(l.path.startsWith(`M ${x(0) + W * 0.3} ${TOP} C`)).toBe(true);
});

test('a loop on an unknown node is left out and leaves no room above the row (#887)', () => {
  const layout = layoutFlow(NODES, [edge('g', 'gone', 'gone')], W);
  expect([layout.top, layout.edges]).toEqual([MARGIN, []]);
});

test('maxNodeHeight leaves the layout\'s room above the row and every arrow below it, never under NODE_MIN; hiddenBelow counts the tasks past the fold (#134, #887)', () => {
  const flat = layoutFlow(NODES, [edge('a', 'checks', 'build'), edge('b', 'pr', 'build', false)], W);
  const looped = layoutFlow(NODES, [edge('l', 'spec', 'spec')], W);
  expect(maxNodeHeight(800, flat)).toBe(800 - MARGIN - 2 * DEPTH - MARGIN);
  expect(maxNodeHeight(800, looped)).toBe(800 - TOP - MARGIN);
  expect(maxNodeHeight(200, flat)).toBe(NODE_MIN);
  expect(hiddenBelow(600, 300, 0, 10)).toBe(5);
  expect(hiddenBelow(600, 300, 300, 10)).toBe(0);
  expect(hiddenBelow(300, 300, 0, 5)).toBe(0);
});
