import { type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTextField } from '@/lib/shortcut-bindings';

// The design pane's zoom and pan (#109), apart from DesignPane.tsx: the fit, the steps, ⌘0, ⌘/Ctrl + wheel and pinch, Space-drag. The zoom is
// whole points, so the bar's label is always what the frame gets.

export const ZOOM_MIN = 10;
export const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const FULL = 100;
const FIT_MARGIN_PX = 32; // the canvas's 16 px of padding on each side

const clamp = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** The percentage that fits `frameWidth` into the canvas's width less its margin (#109): never above 100, so a tall screen stays readable,
 *  nor under ZOOM_MIN. */
export const fitPercent = (canvasWidth: number, frameWidth: number): number =>
  clamp(Math.floor(Math.min(FULL, ((canvasWidth - FIT_MARGIN_PX) / frameWidth) * FULL)));

/** One step of 10 points `direction`'s way, bounded to ZOOM_MIN–ZOOM_MAX (#109). */
export const stepPercent = (zoom: number, direction: 1 | -1): number => clamp(zoom + direction * ZOOM_STEP);

/** What the pane's bar, its section and its canvas take (#109). */
export interface DesignZoom {
  zoom: number; isPanning: boolean;
  zoomBy(direction: 1 | -1): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void; onKeyUp(event: ReactKeyboardEvent<HTMLElement>): void; onBlur(): void;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
}

// The fit: at the first layout where the pane shows with a measured canvas, then on each new frame width (a viewport change) and each
// request (⌘0). A pane mounted behind another tab measures 0 px, so its fit waits until it shows
function useFit(canvas: RefObject<HTMLElement | null>, frameWidth: number, isShown: boolean, setZoom: Dispatch<SetStateAction<number>>): () => void {
  const [request, setRequest] = useState(0);
  const fitted = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const key = `${frameWidth}:${request}`;
    const width = canvas.current?.clientWidth ?? 0;
    if (!isShown || width <= 0 || fitted.current === key) return;
    fitted.current = key;
    setZoom(fitPercent(width, frameWidth));
  }, [canvas, frameWidth, request, isShown, setZoom]);
  return () => setRequest((n) => n + 1);
}

// ⌘/Ctrl + wheel, and a trackpad's pinch (Chromium sends it as a wheel with ctrlKey): one step per event. A listener of its own: React's
// wheel is passive and could not keep the page from zooming. ponytail: a pinch sends many small events, each a full step; scale by deltaY if
// it feels too fast
function useWheelZoom(canvas: RefObject<HTMLElement | null>, setZoom: Dispatch<SetStateAction<number>>): void {
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      setZoom((zoom) => stepPercent(zoom, event.deltaY < 0 ? 1 : -1));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [canvas, setZoom]);
}

// Space held turns a drag on the canvas into its scroll; DesignPane stops the frame from taking the pointer meanwhile
function usePan(canvas: RefObject<HTMLElement | null>): { isPanning: boolean; setPanning(on: boolean): void; onPointerDown(event: ReactPointerEvent<HTMLElement>): void } {
  const [isPanning, setPanning] = useState(false);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    const element = canvas.current;
    if (!isPanning || element === null) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    const move = (moved: PointerEvent): void => {
      element.scrollLeft = start.left - (moved.clientX - start.x);
      element.scrollTop = start.top - (moved.clientY - start.y);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { isPanning, setPanning, onPointerDown };
}

// Space belongs to a field, and to a button, which it presses
const takesSpace = (target: EventTarget | null): boolean => isTextField(target) || target instanceof HTMLButtonElement;

/** The zoom of a design pane (#109): the fit at first show, ⌘0 and a viewport change; ±10-point steps; ⌘/Ctrl + wheel and pinch; Space-drag
 *  pan. The keys act only while the focus is inside the pane: its section takes onKeyDown, onKeyUp and onBlur. */
export function useDesignZoom(canvas: RefObject<HTMLElement | null>, frameWidth: number, isShown: boolean): DesignZoom {
  const [zoom, setZoom] = useState(FULL);
  const refit = useFit(canvas, frameWidth, isShown, setZoom);
  useWheelZoom(canvas, setZoom);
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
    zoom, isPanning: pan.isPanning, onPointerDown: pan.onPointerDown, onKeyDown,
    zoomBy: (direction) => setZoom((current) => stepPercent(current, direction)),
    onKeyUp: (event) => { if (event.key === ' ') pan.setPanning(false); },
    onBlur: () => pan.setPanning(false),
  };
}
