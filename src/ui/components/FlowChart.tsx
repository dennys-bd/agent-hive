import type { ReactNode } from 'react';
import { isAutomatic, transitionKey } from '../../transitions';
import type { Stage, Transition } from '../../types';
import { FlowEdges } from '@/components/FlowEdges';
import { useCanvasPane } from '@/hooks/use-canvas-pane';
import { showsPill, transitionLabel } from '@/lib/flow-labels';
import { isInnerEdge, type LayoutEdge, type LayoutNode, layoutFlow, maxNodeHeight, NODE_MIN, segmentLine } from '@/lib/flow-layout';
import { drawnEdgesOf, type RowEntry, stripsOf } from '@/lib/flow-strips';
import type { EmptyStages, FlowCanvas, LoopLabels, Loops } from '@/lib/flow-view';

export const NODE_WIDTH = 220; // #54: room for a task's ⊘ blocked line and its footer's status beside the button
export const STRIP_WIDTH = 40; // #914: an empty stage, collapsed
export const STRIP_HEIGHT = 300;
/** A strip's height (#914): STRIP_HEIGHT, never past what a node may grow to. */
export const stripHeight = (maxHeight: number): number => Math.min(STRIP_HEIGHT, maxHeight);

interface FlowChartProps {
  stages: readonly Stage[]; transitions: readonly Transition[];
  loops: Loops; labels: LoopLabels; // #576 decisions 2, 3: which arrows draw, which keep their pill
  zoom: number; pan: FlowCanvas['pan']; fitRequest: number; // #910: the stored pan is set once; a new fitRequest fits the chart
  onPan(pan: FlowCanvas['pan']): void; onFit(zoom: number): void; onZoom(zoom: number): void;
  renderNode(stage: Stage, maxHeight: number): ReactNode;
  // #914: how empty stages draw, which are empty (no shown task), and a strip; without renderStrip every stage is a node
  emptyStages?: EmptyStages; isEmpty?(stage: string): boolean; renderStrip?(stages: readonly Stage[], maxHeight: number): ReactNode;
}

// A row entry as layoutFlow places it (#914): a node NODE_WIDTH wide; a strip STRIP_WIDTH wide and at most STRIP_HEIGHT tall, a merged one's
// forward arrow leaving its last segment's line
function rowNode(entry: RowEntry, height: number): LayoutNode {
  if (!entry.isStrip) return { id: entry.id, width: NODE_WIDTH, height };
  const tall = stripHeight(height);
  const count = entry.stages.length;
  return { id: entry.id, width: STRIP_WIDTH, height: tall, ...(count > 1 ? { exit: segmentLine(tall, count, count - 1) } : {}) };
}

// The drawn row's arrows (#576, #914): their ends on the row, each pill as rótulos says. Going back reads the flow's own order; inner reads the
// drawn row, where an arrow inside a strip always is and an arrow to end, with no slot, never is
function chartEdges(stages: readonly Stage[], transitions: readonly Transition[], row: readonly RowEntry[], loopLabels: LoopLabels) {
  const order = new Map(stages.map((s, i) => [s.name, i]));
  const slot = new Map(row.map((r, i) => [r.id, i]));
  const drawn = drawnEdgesOf(row, transitions.map((t): LayoutEdge => ({ id: transitionKey(t), from: t.from, to: t.to, automatic: isAutomatic(t.when), feedback: t.when === 'feedback' })));
  const isBack = (t: Transition): boolean => (order.get(t.to) ?? -1) < (order.get(t.from) ?? -1) && order.has(t.to);
  const isInnerArrow = (k: number): boolean => {
    const [i, j] = [slot.get(drawn[k].from), slot.get(drawn[k].to)];
    return drawn[k].inner === true || (i !== undefined && j !== undefined && isInnerEdge(drawn[k], i, j));
  };
  const hasPill = (t: Transition, k: number): boolean => loopLabels !== 'none' && showsPill(t, isBack(t)) && (loopLabels === 'all' || !isInnerArrow(k));
  const pills = new Set(transitions.filter(hasPill).map(transitionKey));
  // unlabelled: an arrow with no pill needs no room for one, so its neighbours sit closer (#480)
  return { pills, edges: drawn.map((e) => ({ ...e, unlabelled: !pills.has(e.id) })) };
}


/** The flow view's canvas (#134, 1b, #908, #910): it pans both ways with no scrollbar shown and scales by `zoom`, nodes, arrows and pills
 * together, inside a sizer of the scaled size so the scroll follows it; auto margins centre a chart smaller than the canvas and, unlike
 * justify-content, never make an overflow unreachable. Each node sits where layoutFlow puts it and may grow down to the canvas's bottom, the
 * viewport read at the zoom's scale. No arrow reads a node's height, so only the viewport is measured. A stage with no shown task is a strip
 * under exibir's etapas vazias (#914); the chart's width changing never refits, since useCanvasPane fits only on a new fitRequest. */
export function FlowChart({ stages, transitions, loops, labels: loopLabels, zoom, pan, fitRequest, onPan, onFit, onZoom, renderNode, emptyStages = 'open', isEmpty = () => false, renderStrip }: FlowChartProps) {
  const row = stripsOf(stages.map((s) => s.name), isEmpty, renderStrip === undefined ? 'open' : emptyStages);
  const { pills, edges } = chartEdges(stages, transitions, row, loopLabels);
  // top reads the edges alone (#908): a first pass at NODE_MIN gives it, and is the chart fit must show (#910)
  const sized = (height: number) => layoutFlow(row.map((entry) => rowNode(entry, height)), edges, { loops });
  const least = sized(NODE_MIN);
  const { pane, size, onScroll } = useCanvasPane({ zoom, pan, fitRequest, graph: least, onPan, onFit, onZoom });
  const maxHeight = maxNodeHeight(size.height / zoom, least);
  const layout = sized(maxHeight);
  const labels = Object.fromEntries(transitions.map((t) => [transitionKey(t), transitionLabel(t, stages.find((s) => s.name === t.from)?.action)]));
  // layout.nodes keeps the row's order: entry i is box i
  const bodyOf = (entry: RowEntry): ReactNode => {
    const drawn = stages.filter((s) => entry.stages.includes(s.name));
    return entry.isStrip && renderStrip ? renderStrip(drawn, maxHeight) : renderNode(drawn[0], maxHeight);
  };
  return (
    <div ref={pane} data-flow-stages onScroll={onScroll} className="absolute inset-0 flex overflow-auto [scrollbar-width:none]">
      <div className="m-auto shrink-0" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <div className="relative origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          <FlowEdges layout={layout} labels={labels} pills={pills} />
          {layout.nodes.map((box, i) => <div key={box.id} className="absolute" style={{ left: box.x, top: box.y }}>{bodyOf(row[i])}</div>)}
        </div>
      </div>
    </div>
  );
}
