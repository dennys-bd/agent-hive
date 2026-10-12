import { type RefObject, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { FlowView } from '@/lib/flow-view';
import { anchoredScroll, fitZoom } from '@/lib/flow-zoom';

export interface Size { width: number; height: number }
type Pan = FlowView['pan'];
interface CanvasPaneOptions { zoom: number; pan: Pan; fitRequest: number; graph: Size; onPan(pan: Pan): void; onFit(zoom: number): void }
interface CanvasPane { pane: RefObject<HTMLDivElement | null>; size: Size; onScroll(): void }

// The pane's size, read on mount and on every resize; 0, 0 until then and while the flow is hidden under Atividades (#596)
function usePaneSize(pane: RefObject<HTMLDivElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const read = (): void => setSize({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    read();
    return () => observer.disconnect();
  }, [pane]);
  return size;
}

// Scrolls the pane and keeps the copy the anchor and a re-show read
function scrollPane(el: HTMLDivElement, scroll: RefObject<Pan>, next: Pan): void {
  el.scrollLeft = next.x;
  el.scrollTop = next.y;
  scroll.current = next;
}

/** The flow canvas's scrolling pane (#910): its size; the stored pan set the first time the pane has a height (before that the chart is
 * not at its size yet and the scroll would clamp), and the last scroll each time it gets one back; the point at the viewport's centre kept
 * put when the zoom changes; a fit each time `fitRequest` changes (the zoom that shows `graph`, the chart at NODE_MIN, scrolled to 0, 0);
 * and every scroll reported, in scaled pixels. */
export function useCanvasPane({ zoom, pan, fitRequest, graph, onPan, onFit }: CanvasPaneOptions): CanvasPane {
  const pane = useRef<HTMLDivElement>(null);
  const size = usePaneSize(pane);
  const hasHeight = size.height > 0;
  // The pane's last scroll, kept by onScroll: a zoom out shrinks the sizer before the anchor runs and the browser clamps the live offsets, and
  // hiding the flow under Atividades (#596, display: none) drops them; this copy is what the anchor scales and what a re-show puts back
  const scroll = useRef(pan);
  const scrolledAt = useRef(zoom); // the zoom the pane's scroll offsets belong to
  const fits = useRef(fitRequest);
  // Each time the pane gets a height: the stored pan on the first, the last scroll after the flow was hidden
  useLayoutEffect(() => {
    const el = pane.current;
    if (el && hasHeight) scrollPane(el, scroll, scroll.current);
  }, [hasHeight]);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el || scrolledAt.current === zoom) return;
    const { x, y } = scroll.current;
    scrollPane(el, scroll, { x: anchoredScroll(x, el.clientWidth / 2, scrolledAt.current, zoom), y: anchoredScroll(y, el.clientHeight / 2, scrolledAt.current, zoom) });
    scrolledAt.current = zoom;
  }, [zoom]);
  const applyFit = useEffectEvent((el: HTMLDivElement): void => {
    const next = fitZoom(size, graph);
    scrollPane(el, scroll, { x: 0, y: 0 });
    scrolledAt.current = next; // the fit's scroll is already its own: no anchor when its zoom arrives
    onFit(next);
  });
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el || fits.current === fitRequest) return;
    fits.current = fitRequest;
    applyFit(el);
  }, [fitRequest]);
  const onScroll = (): void => {
    const el = pane.current;
    if (!el) return;
    scroll.current = { x: el.scrollLeft, y: el.scrollTop };
    onPan(scroll.current);
  };
  return { pane, size, onScroll };
}
