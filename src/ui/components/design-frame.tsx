import { type CSSProperties, type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import { type DeclaredViewport, DESIGN_VIEWPORT_PX, type DesignViewport } from '../../types';
import { bridgeData } from '@/hooks/use-design-pins';
import { useFileVersion, readVersion } from '@/hooks/use-file-version';
import { usePartVersions } from '@/hooks/use-design-parts';
import type { DesignZoom } from '@/hooks/use-design-zoom';
import { getJson } from '@/lib/api';
import type { DesignTheme } from '@/lib/design-comments';

// What the design pane and the changes pane's comparison share (#109, #675): the frame's mint, reloads, bridge messages, width, viewport list,
// theme post and canvas.

export const FRAME_ASPECT = 0.625; // the frame's height before the bridge's first size: 800 px at 1280 wide
export const FULL = 100;
const MAX_FRAME_PX = 100_000; // a design may post any size: past this, the canvas's layout would choke
const DOTS: CSSProperties = { backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)', backgroundSize: '16px 16px' };
const FRAME_SHADOW = '0 0 0 1px var(--border), 0 4px 12px rgb(0 0 0 / .45)';
const NATURAL_MIN = DESIGN_VIEWPORT_PX.mobile; // an empty page measures 0
const NATURAL_MAX = DESIGN_VIEWPORT_PX.desktop; // a fluid text page measures ~16,900 px; also natural's width before the first measure

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// The Hive's theme as the pane mounts (lib/theme.ts writes it on <html>): the design starts in it, and a toggle never writes it back
export const pageTheme = (): DesignTheme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** The mint route of an activity's design (#108). */
export const designFrameRoute = (activityId: string, path: string): string =>
  `/activities/${encodeURIComponent(activityId)}/design-frame?${new URLSearchParams({ path })}`;

/** What a mint route answers (#108, #675): the frame's URL, or, from the base's, missing when the base has no such screen. */
export type Mint = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; url: string } | { status: 'missing' };

const mintOf = ({ url }: { url?: string }): Mint => (url === undefined ? { status: 'missing' } : { status: 'ready', url });

/** A frame's URL from its mint route (#108, #675); no route asks nothing. A new route or key asks again, and the last URL stands meanwhile, so
 *  a frame does not blank between two bases. A refusal's words stay in the pane, no toast. */
export function useMint(route: string | undefined, key = ''): Mint {
  const [mint, setMint] = useState<Mint>({ status: 'loading' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the trigger of a new mint (a new base blob), not a value it uses
  useEffect(() => {
    if (route === undefined) return undefined;
    let live = true;
    getJson<{ url?: string }>(route).then(
      (answer) => { if (live) setMint(mintOf(answer)); },
      (err: unknown) => { if (live) setMint({ status: 'error', message: messageOf(err) }); },
    );
    return () => { live = false; };
  }, [route, key]);
  return mint;
}

export interface Reloads { count: number; take(): boolean }

// The frame's reloads (#109). No watcher: the 2 s poll. Its first version is remembered; a later different one reloads the frame (a new React
// key, the same URL) and waits for the frame's next ready to be marked, since the protocol has no reloaded message (#108). A file gone (null)
// changes nothing until it comes back. A part the screen's assembly asked for (#421) reloads it the same way, a missing one once it appears
export function useReloads(activityId: string, path: string, parts: readonly string[], isShown: boolean): Reloads {
  const [count, setCount] = useState(0);
  const seen = useRef<string | undefined>(undefined);
  const isPending = useRef(false);
  const bump = (): void => {
    isPending.current = true;
    setCount((n) => n + 1);
  };
  // The first version read at once, not at the poll's first tick 2 s later: a change in between would become the baseline and never reload.
  // ponytail: a pane mounted behind another tab takes its baseline when first shown; re-key the frame on first show if that ever bites
  useEffect(() => {
    if (!isShown || seen.current !== undefined) return undefined;
    let live = true;
    readVersion(activityId, path).then((version) => { if (live && seen.current === undefined && typeof version === 'string') seen.current = version; }, () => undefined);
    return () => { live = false; };
  }, [activityId, path, isShown]);
  useFileVersion(activityId, path, isShown, (version) => {
    if (version === null || version === seen.current) return;
    if (seen.current !== undefined) bump();
    seen.current = version;
  });
  usePartVersions(activityId, path, parts, isShown, bump);
  const take = (): boolean => {
    const was = isPending.current;
    isPending.current = false;
    return was;
  };
  return { count, take };
}

// The bridge's messages (#108), only from this pane's frame and only in the protocol's shape: ready, the frame loaded (again); size, its
// content's height, its overflow width (#241) and its natural width (#341), which the frame takes so the canvas scrolls rather than the
// frame. The design itself may post too: anything else is dropped
export interface FrameSize { height?: number; width?: number; natural?: number }
const isFramePx = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const withoutWidth = ({ height, natural }: FrameSize): FrameSize => ({ height, natural });

export function useFrameMessages(frame: RefObject<HTMLIFrameElement | null>, onReady: () => void): [FrameSize, () => void] {
  const [size, setSize] = useState<FrameSize>({});
  const ready = useEffectEvent(onReady);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = bridgeData(event, frame.current);
      if (data === undefined) return;
      const { type, height, width, natural } = data;
      if (type === 'ready') {
        setSize(withoutWidth); // a reloaded file may no longer overflow: the bridge reports the width again if it still does (#453)
        ready();
      }
      else if (type === 'size' && isFramePx(height)) {
        setSize((now) => ({
          height: Math.min(height, MAX_FRAME_PX),
          width: isFramePx(width) ? Math.min(width, MAX_FRAME_PX) : now.width,
          natural: isFramePx(natural) ? natural : now.natural,
        }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
  // An overflow width belongs to the viewport it was measured at: a viewport change drops it, and the bridge reports the next one if the
  // content still overflows. The natural width is the content's own at any viewport, so it stays
  return [size, () => setSize(withoutWidth)];
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// The bridge's zoom and pan (#346), only from this pane's frame: a ⌘ / Ctrl wheel or a pinch over the frame, anchored at its point there
// (the frame's rect is its scaled one, from the box's top-left), and a middle press, whose drag the pane then follows on its own window.
// A hook of its own, after the zoom: useFrameMessages runs before it, since the frame's size sets the zoom's width
export function useFrameZoom(frame: RefObject<HTMLIFrameElement | null>, zoom: DesignZoom): void {
  const onZoom = useEffectEvent((deltaY: number, x: number, y: number): void => {
    const rect = frame.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const scale = zoom.zoom / FULL;
    zoom.zoomAt(deltaY, { x, y, clientX: rect.left + x * scale, clientY: rect.top + y * scale });
  });
  const onPan = useEffectEvent((): void => zoom.startPan());
  const onPanEnd = useEffectEvent((): void => zoom.endPan());
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = bridgeData(event, frame.current);
      if (data === undefined) return;
      const { type, deltaY, x, y } = data;
      if (type === 'pan') onPan();
      else if (type === 'panEnd') onPanEnd();
      else if (type === 'zoom' && isFiniteNumber(deltaY) && isFiniteNumber(x) && isFiniteNumber(y)) onZoom(deltaY, x, y);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
}

// natural (#341): the content's measured width, held to mobile–desktop, since a fluid page measures far wider than it lays out. A fixed
// viewport: its width. Both widen to the overflow the bridge reports (#241, #453), which a window screen past desktop has and a fluid page lacks
export const frameWidthOf = (viewport: DesignViewport, size: FrameSize): number =>
  Math.max(
    viewport === 'natural' ? Math.min(NATURAL_MAX, Math.max(NATURAL_MIN, size.natural ?? NATURAL_MAX)) : DESIGN_VIEWPORT_PX[viewport],
    size.width ?? 0,
  );

// The switch's list (#341): natural, the viewports the screen declares, then the current one when the screen no longer declares it, so a
// comment pinned there can be reopened
export function switchOf(declared: readonly DeclaredViewport[], current: DesignViewport): DesignViewport[] {
  const list: DesignViewport[] = ['natural', ...declared];
  return list.includes(current) ? list : [...list, current];
}

// '*': the sandboxed frame's origin is opaque, so no named origin matches it; a theme is nothing to hide
export const postTheme = (frame: HTMLIFrameElement | null, theme: DesignTheme): void => {
  frame?.contentWindow?.postMessage({ hive: 'design', type: 'theme', theme }, '*');
};

export interface CanvasProps { canvas: RefObject<HTMLDivElement | null>; box: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLIFrameElement | null>; url?: string; name: string; width: number; height: number; zoom: DesignZoom; reloads: number; isCommenting: boolean; children?: ReactNode }

// The bridge sets the crosshair inside the frame only (#112): the margin takes it here. grabbing while a pan is under way (#346)
function canvasCursor(zoom: DesignZoom, isCommenting: boolean): string | undefined {
  if (zoom.isDragging) return 'grabbing';
  if (zoom.isPanning) return 'grab';
  return isCommenting ? 'crosshair' : undefined;
}

// The canvas scrolls a box the zoomed frame's size, and the frame inside it keeps its own size and scales from its top-left corner: a
// transform alone leaves the layout box, so the canvas would not scroll to a zoomed frame's edges. The box does not clip (overflow visible).
// While Space is held or a pan is under way the frame is off the pointer, so the drag's moves reach the pane's window (#346)
export function DesignCanvas({ canvas, box, frame, url, name, width, height, zoom, reloads, isCommenting, children }: CanvasProps) {
  const scale = zoom.zoom / FULL;
  const isFrameOff = zoom.isPanning || zoom.isDragging;
  return (
    <div ref={canvas} data-design-canvas onPointerDown={zoom.onPointerDown} style={{ ...DOTS, cursor: canvasCursor(zoom, isCommenting) }} className="min-h-0 flex-1 overflow-auto bg-background p-4">
      <div ref={box} data-design-box style={{ width: width * scale, height: height * scale, boxShadow: FRAME_SHADOW }} className="relative mx-auto rounded-md">
        {url !== undefined && (
          <iframe
            key={reloads} ref={frame} src={url} title={name} sandbox="allow-scripts" width={width} height={height} className="block rounded-md border-0"
            style={{ transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: isFrameOff ? 'none' : undefined }}
          />
        )}
        {children}
      </div>
    </div>
  );
}
