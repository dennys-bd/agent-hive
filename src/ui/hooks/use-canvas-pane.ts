import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { FlowView } from '@/lib/flow-view';
import { anchoredScroll, fitZoom, stepZoom } from '@/lib/flow-zoom';

export interface Size { width: number; height: number }
type Pan = FlowView['pan'];
interface CanvasPaneOptions { zoom: number; pan: Pan; fitRequest: number; graph: Size; onPan(pan: Pan): void; onFit(zoom: number): void; onZoom(zoom: number): void }
interface CanvasPane { pane: RefObject<HTMLDivElement | null>; size: Size; onScroll(): void }

// The pane's size, read on mount and on every resize; 0, 0 until then and while the pane is hidden (#596, #498)
export function usePaneSize(pane: RefObject<HTMLDivElement | null>): Size {
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

// ⌘/Ctrl + wheel and a trackpad's pinch (Chromium sends it as a wheel with ctrlKey), as in the design pane (#109): one step per event. A
// listener of its own: React's wheel is passive and could not keep the page from zooming, which it must even at a bound. The pointer's
// offset goes to `anchor` only when the zoom moves: at a bound no zoom effect would run to clear it, and the next button zoom would anchor
// there. ponytail: a pinch sends many small events, each a full step; scale by deltaY if it feels too fast
function useWheelZoom(pane: RefObject<HTMLDivElement | null>, anchor: RefObject<Pan | undefined>, zoom: number, onZoom: (zoom: number) => void): void {
  const onWheel = useEffectEvent((event: WheelEvent, el: HTMLDivElement): void => {
    if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
    event.preventDefault();
    const next = stepZoom(zoom, event.deltaY < 0 ? 1 : -1);
    if (next === zoom) return;
    const rect = el.getBoundingClientRect();
    anchor.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    onZoom(next);
  });
  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    const listener = (event: WheelEvent): void => onWheel(event, el);
    el.addEventListener('wheel', listener, { passive: false });
    return () => el.removeEventListener('wheel', listener);
  }, [pane]);
}

/** The flow canvas's scrolling pane (#910): its size; the stored pan set the first time the pane has a height (before that the chart is
 * not at its size yet and the scroll would clamp), and the last scroll each time it gets one back; the point under a wheel's pointer, or else at the
 * viewport's centre, kept put when the zoom changes (⌘/Ctrl + wheel and pinch step the zoom through `onZoom`); a fit each time `fitRequest` changes (the zoom that shows `graph`, the chart at NODE_MIN, scrolled to 0, 0);
 * and every scroll reported, in scaled pixels. */
export function useCanvasPane({ zoom, pan, fitRequest, graph, onPan, onFit, onZoom }: CanvasPaneOptions): CanvasPane {
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
  const anchor = useRef<Pan | undefined>(undefined); // a wheel's pointer in the pane, for the zoom it asked for only
  useWheelZoom(pane, anchor, zoom, onZoom);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el || scrolledAt.current === zoom) return;
    const at = anchor.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    anchor.current = undefined;
    const { x, y } = scroll.current;
    scrollPane(el, scroll, { x: anchoredScroll(x, at.x, scrolledAt.current, zoom), y: anchoredScroll(y, at.y, scrolledAt.current, zoom) });
    scrolledAt.current = zoom;
  }, [zoom]);
  const applyFit = useEffectEvent((el: HTMLDivElement): void => {
    const next = fitZoom(size, graph);
    scrollPane(el, scroll, { x: 0, y: 0 });
    scrolledAt.current = next; // the fit's scroll is already its own: no anchor when its zoom arrives
    anchor.current = undefined; // a wheel in the same frame would otherwise leave its pointer for the next button zoom
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
