import { useRef, useState } from 'react';
import { type FlowView, readFlowView, writeFlowView } from '@/lib/flow-view';

/** The flowchart's view and what changes it (#909, #910): the loops toggle, the zoom, a fit request the canvas answers with onFit, and the
 * scroll's pan. */
export interface FlowViewControls {
  view: FlowView; fitRequest: number;
  toggleLoops(): void; zoomTo(zoom: number): void; fit(): void;
  onPan(pan: FlowView['pan']): void; onFit(zoom: number): void;
}

/** `flowView` as Flow keeps it: every change writes the whole value, so the toggle, the zoom and the pan never overwrite one another. */
export function useFlowView(_isShown: boolean): FlowViewControls {
  const [view, setView] = useState(readFlowView);
  const [fitRequest, setFitRequest] = useState(0);
  // The scroll's latest pan, out of state: a scroll writes flowView and never renders the flow again; `view.pan` is what the canvas restores
  const pan = useRef(view.pan);
  const save = (next: FlowView): void => {
    const saved = { ...next, pan: pan.current };
    writeFlowView(saved);
    setView(saved);
  };
  const zoomTo = (zoom: number): void => save({ ...view, zoom });
  const fit = (): void => setFitRequest((n) => n + 1);
  return {
    view, fitRequest, zoomTo, fit,
    toggleLoops: () => save({ ...view, loops: !view.loops }),
    onPan: (next) => {
      pan.current = next;
      writeFlowView({ ...view, pan: next });
    },
    onFit: (zoom) => {
      pan.current = { x: 0, y: 0 };
      save({ ...view, zoom });
    },
  };
}
