import { render, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FlowChart, NODE_WIDTH } from '@/components/FlowChart';
import { FlowEdges } from '@/components/FlowEdges';
import { setLanguage } from '@/i18n';
import { GAP, GAP_ARROW, MARGIN, type Layout, type Routed } from '@/lib/flow-layout';
import type { LoopLabels, Loops } from '@/lib/flow-view';
import type { Stage, Transition } from '../../src/types';

// The arrowheads (#269): a fixed size in user space, so they neither scale with the stroke nor grow when an arrow is selected; the selected arrow's head is in foreground, like its line.
const edge = (id: string): Routed => ({ id, kind: 'forward', path: 'M 0 10 L 100 10', label: { x: 50, y: 10 }, dashed: false });
const layout: Layout = { nodes: [], edges: [edge('a'), edge('b')], width: 200, height: 40, levels: 0, top: 0 };

test('every head is a fixed 6px in user space; the selected arrow gets the foreground head, the others the border one (#269)', () => {
  const { container } = render(<FlowEdges layout={layout} labels={{}} selected="b" />);
  const markerOf = (id: string) => {
    const ref = container.querySelector(`[data-edge="${id}"]`)?.getAttribute('marker-end') ?? '';
    return container.querySelector(`marker${ref.slice(4, -1)}`) as SVGMarkerElement;
  };
  for (const id of ['a', 'b']) {
    const marker = markerOf(id);
    expect(marker).toHaveAttribute('markerUnits', 'userSpaceOnUse');
    expect(marker).toHaveAttribute('markerWidth', '6');
    expect(marker).toHaveAttribute('markerHeight', '6');
    expect(marker).toHaveAttribute('refX', '8');
  }
  expect(markerOf('a').querySelector('path')).toHaveAttribute('fill', 'var(--border)');
  expect(markerOf('b').querySelector('path')).toHaveAttribute('fill', 'var(--foreground)');
});

// #576: a neighbour arrow with a pill (inner), a back edge over b (outer) and a feedback loop on b (outer)
const CHART_STAGES: Stage[] = ['a', 'b', 'c'].map((name) => ({ name, from: {} }));
const CHART_ARROWS: Transition[] = [
  { from: 'a', to: 'b', when: 'verdict', verdict: 'failed', label: 'inner pill' },
  { from: 'c', to: 'a', when: 'done', label: 'outer pill' },
  { from: 'b', to: 'b', when: 'feedback' },
];
const noop = (): void => undefined;
const chart = (loops: Loops, labels: LoopLabels) => (
  <FlowChart
    stages={CHART_STAGES} transitions={CHART_ARROWS} loops={loops} labels={labels} zoom={1} pan={{ x: 0, y: 0 }} fitRequest={0}
    onPan={noop} onFit={noop} onZoom={noop} renderNode={(stage) => <span data-node={stage.name}>{stage.name}</span>}
  />
);
const pillsOf = (container: HTMLElement): string[] => ['inner pill', 'outer pill', 'feedback'].filter((p) => within(container).queryByText(p) !== null);
const leftOf = (container: HTMLElement, name: string): string => container.querySelector<HTMLElement>(`[data-node="${name}"]`)!.parentElement!.style.left;

test('rótulos todos keeps every pill; só externas drops the inner arrow\'s and its pair packs to GAP_ARROW; nenhum drops them all (#576)', () => {
  setLanguage('pt');
  const { container, rerender } = render(chart('all', 'all'));
  expect(pillsOf(container)).toEqual(['inner pill', 'outer pill', 'feedback']);
  expect(leftOf(container, 'b')).toBe(`${MARGIN + NODE_WIDTH + GAP}px`);
  rerender(chart('all', 'outer'));
  expect(pillsOf(container)).toEqual(['outer pill', 'feedback']);
  expect(leftOf(container, 'b')).toBe(`${MARGIN + NODE_WIDTH + GAP_ARROW}px`);
  rerender(chart('all', 'none'));
  expect(pillsOf(container)).toEqual([]);
});

test('voltas só internas draws the neighbour arrow alone, and the outer pills go with their arrows (#576)', () => {
  setLanguage('pt');
  const { container } = render(chart('inner', 'all'));
  expect(container.querySelectorAll('path[data-kind]')).toHaveLength(1);
  expect(pillsOf(container)).toEqual(['inner pill']);
});
