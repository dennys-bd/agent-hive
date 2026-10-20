import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FlowEdges } from '@/components/FlowEdges';
import type { Layout, Routed } from '@/lib/flow-layout';

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
