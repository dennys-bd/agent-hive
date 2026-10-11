import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { isAutomatic, transitionKey } from '../../transitions';
import type { Stage, Transition } from '../../types';
import { FlowEdges } from '@/components/FlowEdges';
import { transitionLabel } from '@/lib/flow-labels';
import { layoutFlow, maxNodeHeight, NODE_MIN } from '@/lib/flow-layout';

export const NODE_WIDTH = 190;

interface FlowChartProps {
  stages: readonly Stage[]; transitions: readonly Transition[];
  renderNode(stage: Stage, maxHeight: number): ReactNode;
}

/** The flow view's canvas (#134, 1b, #908): it pans both ways with no scrollbar shown; each node sits where layoutFlow puts it and may grow down
 * to the canvas's bottom. No arrow reads a node's height, so only the viewport is measured. */
export function FlowChart({ stages, transitions, renderNode }: FlowChartProps) {
  const [viewport, setViewport] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
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
  // top reads the edges alone (#908): a first pass at any height gives it, then every node is laid out at the height the viewport leaves
  const sized = (height: number) => layoutFlow(stages.map((s) => ({ id: s.name, height })), edges, NODE_WIDTH);
  const maxHeight = maxNodeHeight(viewport, sized(NODE_MIN));
  const layout = sized(maxHeight);
  const labels = Object.fromEntries(transitions.map((t) => [transitionKey(t), transitionLabel(t)]));
  return (
    <div ref={pane} data-flow-stages className="absolute inset-0 overflow-auto [scrollbar-width:none]">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <FlowEdges layout={layout} labels={labels} />
        {layout.nodes.map((box) => {
          const stage = stages.find((s) => s.name === box.id);
          return stage && <div key={box.id} className="absolute" style={{ left: box.x, top: box.y }}>{renderNode(stage, maxHeight)}</div>;
        })}
      </div>
    </div>
  );
}
