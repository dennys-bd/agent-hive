import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isAutomatic, transitionKey } from '../../transitions';
import type { Stage, Transition } from '../../types';
import { FlowEdges } from '@/components/FlowEdges';
import { transitionLabel } from '@/lib/flow-labels';
import { layoutFlow, maxNodeHeight, NODE_MIN } from '@/lib/flow-layout';

export const NODE_WIDTH = 190;

interface FlowChartProps {
  stages: readonly Stage[]; transitions: readonly Transition[];
  renderNode(stage: Stage, maxHeight: number, onHeight: (stage: string, height: number) => void): ReactNode;
}

/** The flow view's canvas (#134, 1b): it pans both ways with no scrollbar shown; each node sits where layoutFlow puts it, measured, and the arrows
 * run from each node's real bottom. The tallest a node grows is what the canvas leaves under the row. onHeight is one stable callback, so a
 * node's measuring effect never loops. */
export function FlowChart({ stages, transitions, renderNode }: FlowChartProps) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [viewport, setViewport] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  const onHeight = useCallback((stage: string, height: number): void => setHeights((was) => (was[stage] === height ? was : { ...was, [stage]: height })), []);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const read = (): void => setViewport(el.clientHeight);
    const observer = new ResizeObserver(read);
    observer.observe(el);
    read();
    return () => observer.disconnect();
  }, []);
  const edges = transitions.map((t) => ({ id: transitionKey(t), from: t.from, to: t.to, automatic: isAutomatic(t.when) }));
  const layout = layoutFlow(stages.map((s) => ({ id: s.name, height: heights[s.name] || NODE_MIN })), edges, NODE_WIDTH);
  const labels = Object.fromEntries(transitions.map((t) => [transitionKey(t), transitionLabel(t)]));
  const maxHeight = maxNodeHeight(viewport, layout);
  return (
    <div ref={pane} data-flow-stages className="absolute inset-0 overflow-auto [scrollbar-width:none]">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <FlowEdges layout={layout} labels={labels} />
        {layout.nodes.map((box) => {
          const stage = stages.find((s) => s.name === box.id);
          return stage && <div key={box.id} className="absolute" style={{ left: box.x, top: box.y }}>{renderNode(stage, maxHeight, onHeight)}</div>;
        })}
      </div>
    </div>
  );
}
