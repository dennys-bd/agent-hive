import { type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { isTextField } from '@/lib/shortcut-bindings';

// The design pane's zoom and pan (#109, #346), apart from DesignPane.tsx: the fit, the steps, ⌘0, ⌘/Ctrl + wheel and pinch anchored at the
// cursor, Space-drag and the middle button. The zoom shown is whole points, so the bar's label is always what the frame gets; the wheel keeps
// the unrounded value between events, so a pinch's small deltas add up instead of rounding away.

export const ZOOM_MIN = 10;
export const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const FULL = 100;
const FIT_MARGIN_PX = 32; // the canvas's 16 px of padding on each side
const WHEEL_DELTA_MAX = 10; // a mouse notch's ~100 counts as 10: about 10 %, close to a step
const WHEEL_SCALE = 100; // a pinch sends −100 × ln(scale) in all, so e^(−Σ deltaY / 100) is the pinch's own factor
const MIDDLE_BUTTON = 1;
// blur: a button released outside the window never leaves the frame off the pointer
const PAN_ENDS = ['pointerup', 'pointercancel', 'blur'] as const;

const clamp = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** The percentage that fits `frameWidth` into the canvas's width less its margin (#109): never above 100, so a tall screen stays readable,
 *  nor under ZOOM_MIN. */
export const fitPercent = (canvasWidth: number, frameWidth: number): number =>
  clamp(Math.floor(Math.min(FULL, ((canvasWidth - FIT_MARGIN_PX) / frameWidth) * FULL)));

/** One step of 10 points `direction`'s way, bounded to ZOOM_MIN–ZOOM_MAX (#109). */
export const stepPercent = (zoom: number, direction: 1 | -1): number => clamp(zoom + direction * ZOOM_STEP);

/** The ⌘/Ctrl wheel's zoom (#346): `zoom × e^(−deltaY / 100)`, each deltaY held to ±10, bounded to ZOOM_MIN–ZOOM_MAX, not rounded. */
export const wheelPercent = (zoom: number, deltaY: number): number =>
  clamp(zoom * Math.exp(-Math.min(WHEEL_DELTA_MAX, Math.max(-WHEEL_DELTA_MAX, deltaY)) / WHEEL_SCALE));

/** A wheel zoom's anchor (#346): the cursor's point on the frame in unscaled frame px, and its client point in the pane's window. */
export interface ZoomAnchor { x: number; y: number; clientX: number; clientY: number }

/** What the pane's bar, its section and its canvas take (#109, #346). */
export interface DesignZoom {
  zoom: number; isPanning: boolean; isDragging: boolean;
  zoomBy(direction: 1 | -1): void;
  zoomAt(deltaY: number, anchor: ZoomAnchor): void;
  startPan(): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void; onKeyUp(event: ReactKeyboardEvent<HTMLElement>): void; onBlur(): void;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
}

// The unrounded zoom, and the wheel's anchor to keep once it lays out; a step and a fit carry none
interface ZoomView { exact: number; anchor: ZoomAnchor | null }

// The fit: at the first layout where the pane shows with a measured canvas, then on each new frame width (a viewport change) and each
// request (⌘0). A pane mounted behind another tab measures 0 px, so its fit waits until it shows
function useFit(canvas: RefObject<HTMLElement | null>, frameWidth: number, isShown: boolean, setView: Dispatch<SetStateAction<ZoomView>>): () => void {
  const [request, setRequest] = useState(0);
  const fitted = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const key = `${frameWidth}:${request}`;
    const width = canvas.current?.clientWidth ?? 0;
    if (!isShown || width <= 0 || fitted.current === key) return;
    fitted.current = key;
    setView({ exact: fitPercent(width, frameWidth), anchor: null });
  }, [canvas, frameWidth, request, isShown, setView]);
  return () => setRequest((n) => n + 1);
}

// ⌘/Ctrl + wheel, and a trackpad's pinch (Chromium sends it as a wheel with ctrlKey). A listener of its own: React's wheel is passive and
// could not keep the page from zooming
function useWheelZoom(canvas: RefObject<HTMLElement | null>, onZoom: (event: WheelEvent) => void): void {
  const zoomed = useEffectEvent(onZoom);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      zoomed(event);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [canvas]);
}

// The cursor's frame point, from the box's rect at the zoom the event happened at; no box, no anchor
function anchorOf(box: HTMLElement | null, event: WheelEvent, zoom: number): ZoomAnchor | null {
  if (box === null) return null;
  const rect = box.getBoundingClientRect();
  const scale = zoom / FULL;
  return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale, clientX: event.clientX, clientY: event.clientY };
}

// The anchored point back under the cursor once the new zoom has laid out: the box's rect is read then, so the mx-auto centring and the
// canvas's padding are in it
function useAnchor(canvas: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>, view: ZoomView): void {
  useLayoutEffect(() => {
    const { anchor } = view;
    const element = canvas.current;
    const rect = box.current?.getBoundingClientRect();
    if (anchor === null || element === null || rect === undefined) return;
    const scale = Math.round(view.exact) / FULL;
    element.scrollLeft += rect.left + anchor.x * scale - anchor.clientX;
    element.scrollTop += rect.top + anchor.y * scale - anchor.clientY;
  }, [canvas, box, view]);
}

interface Pan { isPanning: boolean; isDragging: boolean; setPanning(on: boolean): void; startPan(): void; onPointerDown(event: ReactPointerEvent<HTMLElement>): void }
interface PanStart { x: number; y: number; left: number; top: number }

// Space held, or the middle button, turns a drag on the canvas into its scroll. startPan begins one for the frame's middle press (#346), whose
// position the pane cannot read: the first move sets it. DesignPane keeps the frame off the pointer meanwhile
function usePan(canvas: RefObject<HTMLElement | null>): Pan {
  const [isPanning, setPanning] = useState(false);
  const [isDragging, setDragging] = useState(false);
  const endCurrent = useRef<(() => void) | null>(null); // a second pan starting ends the first, or their window listeners would stack
  const drag = (from: { x: number; y: number } | null): void => {
    const element = canvas.current;
    if (element === null) return;
    endCurrent.current?.();
    const startAt = (x: number, y: number): PanStart => ({ x, y, left: element.scrollLeft, top: element.scrollTop });
    let start: PanStart | null = from === null ? null : startAt(from.x, from.y);
    const move = (moved: PointerEvent): void => {
      if (start === null) {
        start = startAt(moved.clientX, moved.clientY);
        return;
      }
      element.scrollLeft = start.left - (moved.clientX - start.x);
      element.scrollTop = start.top - (moved.clientY - start.y);
    };
    const end = (): void => {
      window.removeEventListener('pointermove', move);
      for (const type of PAN_ENDS) window.removeEventListener(type, end);
      endCurrent.current = null;
      setDragging(false);
    };
    endCurrent.current = end;
    window.addEventListener('pointermove', move);
    for (const type of PAN_ENDS) window.addEventListener(type, end);
    setDragging(true);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!isPanning && event.button !== MIDDLE_BUTTON) return;
    event.preventDefault();
    drag({ x: event.clientX, y: event.clientY });
  };
  return { isPanning, isDragging, setPanning, onPointerDown, startPan: () => drag(null) };
}

// Space belongs to a field, and to a button, which it presses
const takesSpace = (target: EventTarget | null): boolean => isTextField(target) || target instanceof HTMLButtonElement;

/** The zoom of a design pane (#109, #346): the fit at first show, ⌘0 and a viewport change; ±10-point steps; ⌘/Ctrl + wheel and pinch,
 *  proportional and anchored at the cursor; Space-drag and middle-button pan. `box` is the frame's scaled box, the anchor's reference. The
 *  keys act only while the focus is inside the pane: its section takes onKeyDown, onKeyUp and onBlur. */
export function useDesignZoom(canvas: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>, frameWidth: number, isShown: boolean): DesignZoom {
  const [view, setView] = useState<ZoomView>({ exact: FULL, anchor: null });
  const zoom = Math.round(view.exact);
  const refit = useFit(canvas, frameWidth, isShown, setView);
  useAnchor(canvas, box, view);
  const zoomAt = (deltaY: number, anchor: ZoomAnchor | null): void => setView((now) => ({ exact: wheelPercent(now.exact, deltaY), anchor }));
  useWheelZoom(canvas, (event) => zoomAt(event.deltaY, anchorOf(box.current, event, zoom)));
  const pan = usePan(canvas);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === '0') {
      event.preventDefault();
      refit(); // not named fit: biome reads that as a focused test
    } else if (event.key === ' ' && !takesSpace(event.target)) {
      event.preventDefault(); // Space would scroll the canvas a page
      pan.setPanning(true);
    }
  };
  return {
    zoom, isPanning: pan.isPanning, isDragging: pan.isDragging, startPan: pan.startPan, onPointerDown: pan.onPointerDown, onKeyDown, zoomAt,
    zoomBy: (direction) => setView((now) => ({ exact: stepPercent(Math.round(now.exact), direction), anchor: null })),
    onKeyUp: (event) => { if (event.key === ' ') pan.setPanning(false); },
    onBlur: () => pan.setPanning(false),
  };
}
