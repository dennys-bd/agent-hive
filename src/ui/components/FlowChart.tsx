import type { ReactNode } from 'react';
import { isAutomatic, transitionKey } from '../../transitions';
import type { Stage, Transition } from '../../types';
import { FlowEdges } from '@/components/FlowEdges';
import { useCanvasPane } from '@/hooks/use-canvas-pane';
import { showsPill, transitionLabel } from '@/lib/flow-labels';
import { layoutFlow, maxNodeHeight, NODE_MIN } from '@/lib/flow-layout';
import type { FlowView } from '@/lib/flow-view';

export const NODE_WIDTH = 190;

interface FlowChartProps {
  stages: readonly Stage[]; transitions: readonly Transition[];
  loops: boolean; // #909: false draws only the arrows forward
  zoom: number; pan: FlowView['pan']; fitRequest: number; // #910: the stored pan is set once; a new fitRequest fits the chart
  onPan(pan: FlowView['pan']): void; onFit(zoom: number): void;
  renderNode(stage: Stage, maxHeight: number): ReactNode;
}

/** The flow view's canvas (#134, 1b, #908, #910): it pans both ways with no scrollbar shown and scales by `zoom`, nodes, arrows and pills
 * together, inside a sizer of the scaled size so the scroll follows it; auto margins centre a chart smaller than the canvas and, unlike
 * justify-content, never make an overflow unreachable. Each node sits where layoutFlow puts it and may grow down to the canvas's bottom, the
 * viewport read at the zoom's scale. No arrow reads a node's height, so only the viewport is measured. */
export function FlowChart({ stages, transitions, loops, zoom, pan, fitRequest, onPan, onFit, renderNode }: FlowChartProps) {
  const order = new Map(stages.map((s, i) => [s.name, i]));
  const isBack = (t: Transition): boolean => {
    const [i, j] = [order.get(t.from), order.get(t.to)];
    return i !== undefined && j !== undefined && j < i;
  };
  const pills = new Set(transitions.filter((t) => showsPill(t, isBack(t))).map(transitionKey));
  // labelled: a skip forward that carries a pill says why it skips, so it stays with the loops hidden (#909)
  const edges = transitions.map((t) => ({ id: transitionKey(t), from: t.from, to: t.to, automatic: isAutomatic(t.when), labelled: pills.has(transitionKey(t)) }));
  // top reads the edges alone (#908): a first pass at NODE_MIN gives it, and is the chart fit must show (#910)
  const sized = (height: number) => layoutFlow(stages.map((s) => ({ id: s.name, height })), edges, NODE_WIDTH, { loops });
  const least = sized(NODE_MIN);
  const { pane, size, onScroll } = useCanvasPane({ zoom, pan, fitRequest, graph: least, onPan, onFit });
  // #910: the viewport at the zoom's scale, so a node zoomed out still reaches the canvas's bottom and shows more of its tasks
  const maxHeight = maxNodeHeight(size.height / zoom, least);
  const layout = sized(maxHeight);
  const labels = Object.fromEntries(transitions.map((t) => [transitionKey(t), transitionLabel(t)]));
  return (
    <div ref={pane} data-flow-stages onScroll={onScroll} className="absolute inset-0 flex overflow-auto [scrollbar-width:none]">
      <div className="m-auto shrink-0" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <div className="relative origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          <FlowEdges layout={layout} labels={labels} pills={pills} />
          {layout.nodes.map((box) => {
            const stage = stages.find((s) => s.name === box.id);
            return stage && <div key={box.id} className="absolute" style={{ left: box.x, top: box.y }}>{renderNode(stage, maxHeight)}</div>;
          })}
        </div>
      </div>
    </div>
  );
}
