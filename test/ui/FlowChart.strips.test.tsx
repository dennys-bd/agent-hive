import { render, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { FlowChart, NODE_WIDTH, STRIP_WIDTH } from '@/components/FlowChart';
import { setLanguage } from '@/i18n';
import { GAP, GAP_ARROW, MARGIN } from '@/lib/flow-layout';
import type { EmptyStages, LoopLabels, Loops } from '@/lib/flow-view';
import type { Stage, Transition } from '../../src/types';

// a, r, f, b with r and f empty (#914): a done chain, a verdict back from f to r with a pill (inside a merged strip), and a back edge over all
const STAGES: Stage[] = ['a', 'r', 'f', 'b'].map((name) => ({ name, from: {} }));
const ARROWS: Transition[] = [
  { from: 'a', to: 'r', when: 'done' }, { from: 'r', to: 'f', when: 'done' }, { from: 'f', to: 'b', when: 'done' },
  { from: 'f', to: 'r', when: 'verdict', verdict: 'failed', label: 'side pill' }, { from: 'b', to: 'a', when: 'done', label: 'outer pill' },
];
const EMPTY = new Set(['r', 'f']);
const noop = (): void => undefined;
const chart = (emptyStages: EmptyStages, loops: Loops = 'all', labels: LoopLabels = 'all') => (
  <FlowChart
    stages={STAGES} transitions={ARROWS} loops={loops} labels={labels} zoom={1} pan={{ x: 0, y: 0 }} fitRequest={0} onPan={noop} onFit={noop} onZoom={noop}
    renderNode={(stage) => <span data-node={stage.name}>{stage.name}</span>}
    emptyStages={emptyStages} isEmpty={(name) => EMPTY.has(name)} renderStrip={(stages) => <span data-strip-of={stages.map((s) => s.name).join(',')} />}
  />
);
const drawn = (container: HTMLElement): string[] => [...container.querySelectorAll('[data-node], [data-strip-of]')].map((el) => el.getAttribute('data-node') ?? `[${el.getAttribute('data-strip-of')}]`);
const kinds = (container: HTMLElement): string[] => [...container.querySelectorAll('path[data-kind]')].map((p) => p.getAttribute('data-kind') ?? '');
const leftOf = (container: HTMLElement, selector: string): string => container.querySelector<HTMLElement>(selector)!.parentElement!.style.left;
const pills = (container: HTMLElement): string[] => ['side pill', 'outer pill'].filter((p) => within(container).queryByText(p) !== null);
beforeEach(() => setLanguage('pt'));

test('merge draws one strip for r and f, between a and b; the two arrows inside it are side arcs (#914)', () => {
  const { container } = render(chart('merge'));
  expect(drawn(container)).toEqual(['a', '[r,f]', 'b']);
  expect(kinds(container).filter((k) => k === 'side')).toHaveLength(2);
  // the side pill bulges into the gap before the strip, which keeps GAP for it; the strip is STRIP_WIDTH wide
  expect(leftOf(container, '[data-strip-of]')).toBe(`${MARGIN + NODE_WIDTH + GAP}px`);
  expect(leftOf(container, '[data-node="b"]')).toBe(`${MARGIN + NODE_WIDTH + GAP + STRIP_WIDTH + GAP_ARROW}px`);
});

test('collapse draws a strip each and no side arc; open draws every stage as a node; without renderStrip every stage is a node (#914)', () => {
  const { container, rerender } = render(chart('collapse'));
  expect(drawn(container)).toEqual(['a', '[r]', '[f]', 'b']);
  expect(kinds(container)).not.toContain('side');
  rerender(chart('open'));
  expect(drawn(container)).toEqual(['a', 'r', 'f', 'b']);
  rerender(<FlowChart stages={STAGES} transitions={ARROWS} loops="all" labels="all" zoom={1} pan={{ x: 0, y: 0 }} fitRequest={0} onPan={noop} onFit={noop} onZoom={noop} renderNode={(stage) => <span data-node={stage.name}>{stage.name}</span>} emptyStages="merge" isEmpty={() => true} />);
  expect(drawn(container)).toEqual(['a', 'r', 'f', 'b']);
});

test('the arrows inside a strip follow voltas as inner ones: kept under só internas, gone under nenhuma (#576, #914)', () => {
  const { container, rerender } = render(chart('merge', 'inner'));
  expect(kinds(container)).toEqual(['forward', 'side', 'forward', 'side']); // a→strip, r→f, strip→b, f→r; b→a is outer
  rerender(chart('merge', 'none'));
  expect(kinds(container)).toEqual([]);
});

test('rótulos só externas drops the side pill and keeps the outer one, and the room before the strip shrinks to GAP_ARROW; nenhum drops both (#576, #914)', () => {
  const { container, rerender } = render(chart('merge'));
  expect(pills(container)).toEqual(['side pill', 'outer pill']);
  rerender(chart('merge', 'all', 'outer'));
  expect(pills(container)).toEqual(['outer pill']);
  expect(leftOf(container, '[data-strip-of]')).toBe(`${MARGIN + NODE_WIDTH + GAP_ARROW}px`);
  rerender(chart('merge', 'all', 'none'));
  expect(pills(container)).toEqual([]);
});
