import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type Size, usePaneSize } from '@/hooks/use-canvas-pane';
import { type DiskVersion, useFileVersion } from '@/hooks/use-file-version';
import { t } from '@/i18n';
import * as models from '@/lib/editor-models';
import { messageOf } from '@/lib/read-error';
import { anchoredScroll } from '@/lib/flow-zoom';

// The file tab's image (#498): the disk's bytes as an object URL in an <img>, which never runs an SVG's scripts, zoomed from 10% to 800%

const SCALE_MIN = 0.1;
const SCALE_MAX = 8;
// −/+ go stop to stop so the label stays round; from a fit's odd scale, to the next stop either way
const STOPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const EPSILON = 1e-6;
const WHEEL_PX_PER_DOUBLING = 200; // a mouse notch (~100 px) is ×1.4; a pinch's many small deltas zoom smoothly instead of a stop each
const KB = 1024;
const MB = KB * KB;
// Two theme surfaces in 8 px squares behind the image: a transparent pixel reads in both themes
const CHECKERBOARD = { backgroundImage: 'repeating-conic-gradient(var(--muted) 0% 25%, var(--card) 0% 50%)', backgroundSize: '16px 16px' } as const;

type ImageLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; url: string; bytes: number };
type Zoom = number | 'fit';
interface Point { x: number; y: number }

/** onViewSource: an SVG's ver código, which the editor pane answers by showing its source (#498). */
export interface ImageViewProps { activityId: string; path: string; active: boolean; onViewSource?(): void }

const clampScale = (scale: number): number => Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
const stepScale = (scale: number, direction: 1 | -1): number =>
  (direction === 1 ? STOPS.find((stop) => stop > scale + EPSILON) : STOPS.filter((stop) => stop < scale - EPSILON).at(-1)) ?? scale;

// The scale that shows the whole image, never above 100%; an unmeasured pane (hidden, or jsdom) fits at 100%
function fitScale(box: Size, image: Size): number {
  const ratio = Math.min(box.width / image.width, box.height / image.height);
  return box.width > 0 && box.height > 0 && Number.isFinite(ratio) ? clampScale(Math.min(1, ratio)) : 1;
}

function sizeLabel(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  return bytes < MB ? `${(bytes / KB).toFixed(1)} KB` : `${(bytes / MB).toFixed(1)} MB`;
}

// The image's bytes into an object URL, fetched again when the poll finds another version while the tab shows; the URL on screen is revoked
// once the next replaces it, and with the view. ponytail: the poll's first answer is the baseline, so a write within the first poll after
// the open waits for the next one; the route could answer its version in a header if that ever shows
function useImage(activityId: string, path: string, isShown: boolean): ImageLoad {
  const [load, setLoad] = useState<ImageLoad>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  const onScreen = useRef<string | undefined>(undefined);
  useEffect(() => () => { if (onScreen.current !== undefined) URL.revokeObjectURL(onScreen.current); }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is the trigger of a new read, not a value it uses
  useEffect(() => {
    let live = true;
    models.readImage(activityId, path).then((blob) => {
      if (!live) return;
      const previous = onScreen.current;
      onScreen.current = URL.createObjectURL(blob);
      setLoad({ status: 'ready', url: onScreen.current, bytes: blob.size });
      if (previous !== undefined) URL.revokeObjectURL(previous);
    }, (err: unknown) => { if (live) setLoad({ status: 'error', message: messageOf(err) }); });
    return () => { live = false; };
  }, [activityId, path, reads]);
  const seen = useRef<DiskVersion | undefined>(undefined);
  useFileVersion(activityId, path, isShown, (version) => {
    if (seen.current !== undefined && version !== seen.current) setReads((n) => n + 1); // a file gone (null) reads again too: its 404 says so
    seen.current = version;
  });
  return load;
}

// Fit until a button or the wheel picks a scale. The point under the wheel's pointer, else the pane's centre, stays put, as the flow canvas
// does (#910). ⌘/Ctrl + wheel and a pinch (Chromium's ctrl wheel) on a listener of its own: React's wheel is passive and could not keep the
// window from zooming. ponytail: the anchor counts from the scroller's origin, so it drifts while the image is still smaller than the pane
// and centred; offset by the centring if that shows
function useZoom(pane: RefObject<HTMLDivElement | null>, fit: number): { zoom: Zoom; scale: number; setZoom(zoom: Zoom, at?: Point): void } {
  const [zoom, setZoomState] = useState<Zoom>('fit');
  const scale = zoom === 'fit' ? fit : zoom;
  const anchor = useRef<Point | undefined>(undefined);
  const scrolledAt = useRef(scale);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el || scrolledAt.current === scale) return;
    const at = anchor.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    anchor.current = undefined;
    el.scrollLeft = anchoredScroll(el.scrollLeft, at.x, scrolledAt.current, scale);
    el.scrollTop = anchoredScroll(el.scrollTop, at.y, scrolledAt.current, scale);
    scrolledAt.current = scale;
  }, [pane, scale]);
  const setZoom = (next: Zoom, at?: Point): void => {
    anchor.current = at;
    setZoomState(next);
  };
  const onWheel = useEffectEvent((event: WheelEvent, el: HTMLDivElement): void => {
    if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
    event.preventDefault();
    const next = clampScale(scale * 2 ** (-event.deltaY / WHEEL_PX_PER_DOUBLING));
    const rect = el.getBoundingClientRect();
    if (next !== scale) setZoom(next, { x: event.clientX - rect.left, y: event.clientY - rect.top }); // at a bound no effect would clear the anchor
  });
  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    const listener = (event: WheelEvent): void => onWheel(event, el);
    el.addEventListener('wheel', listener, { passive: false });
    return () => el.removeEventListener('wheel', listener);
  }, [pane]);
  return { zoom, scale, setZoom };
}

interface ImageBarProps { path: string; detail?: string; zoom: Zoom; scale: number; canZoom: boolean; onZoom(zoom: Zoom): void; onViewSource?(): void }

// The bar (#498), one 24 px row as the editor's (#850): the path, `{w} × {h} · {size}`, the zoom as the flow canvas's (#910) and an SVG's ver código
function ImageBar({ path, detail, zoom, scale, canZoom, onZoom, onViewSource }: ImageBarProps) {
  const button = 'h-5 tabular-nums';
  return (
    <div className="flex h-6 shrink-0 items-center gap-2 border-b px-2.5 text-muted-foreground text-xs leading-none">
      <span title={path} className="min-w-0 flex-1 truncate font-mono">{path}</span>
      {detail !== undefined && <span className="shrink-0 tabular-nums">{detail}</span>}
      {canZoom && (
        <div className="flex shrink-0 items-center">
          <Button type="button" variant="ghost" size="xs" className={button} aria-pressed={zoom === 'fit'} onClick={() => onZoom('fit')}>{t('image.fit')}</Button>
          <Button type="button" variant="ghost" size="xs" className={button} aria-label={t('image.zoomOut')} disabled={scale <= SCALE_MIN + EPSILON} onClick={() => onZoom(stepScale(scale, -1))}>−</Button>
          <Button type="button" variant="ghost" size="xs" className={button} title={t('image.actualSize')} onClick={() => onZoom(1)}>{`${Math.round(scale * 100)}%`}</Button>
          <Button type="button" variant="ghost" size="xs" className={button} aria-label={t('image.zoomIn')} disabled={scale >= SCALE_MAX - EPSILON} onClick={() => onZoom(stepScale(scale, 1))}>+</Button>
        </div>
      )}
      {onViewSource && <Button type="button" variant="link" size="xs" className="h-5 p-0 text-review" onClick={onViewSource}>{t('image.viewSource')}</Button>}
    </div>
  );
}

const detailOf = (load: ImageLoad, natural: Size | undefined): string | undefined => {
  if (load.status !== 'ready') return undefined;
  const size = sizeLabel(load.bytes);
  return natural !== undefined && natural.width > 0 ? `${natural.width} × ${natural.height} · ${size}` : size; // an SVG with no size of its own
};

function failureOf(load: ImageLoad, isBroken: boolean): string | undefined {
  if (load.status === 'error') return load.message;
  return isBroken ? t('image.invalid') : undefined;
}

/** The file tab's image (#498): the disk's file, never an editor buffer, on a checkerboard, fitted on open, scrolling above the pane's size;
 * reloaded when the disk's version moves while the tab shows. A failed read says why; an image the browser cannot decode, imagem inválida. */
export function ImageView({ activityId, path, active, onViewSource }: ImageViewProps) {
  const pane = useRef<HTMLDivElement>(null);
  const load = useImage(activityId, path, active);
  const box = usePaneSize(pane);
  const [natural, setNatural] = useState<Size>();
  const [brokenUrl, setBrokenUrl] = useState<string>();
  const base = natural !== undefined && natural.width > 0 && natural.height > 0 ? natural : box; // no size of its own: laid out at the pane's
  const { zoom, scale, setZoom } = useZoom(pane, fitScale(box, base));
  const url = load.status === 'ready' ? load.url : undefined;
  const isBroken = url !== undefined && url === brokenUrl;
  const message = failureOf(load, isBroken);
  return (
    <>
      <ImageBar path={path} detail={detailOf(load, natural)} zoom={zoom} scale={scale} canZoom={url !== undefined && !isBroken} onZoom={setZoom} onViewSource={onViewSource} />
      {load.status === 'loading' && <p className="p-3 text-muted-foreground text-xs">{t('files.loading')}</p>}
      {message !== undefined && <p role="alert" className="p-3 text-destructive text-xs">{message}</p>}
      <div ref={pane} hidden={url === undefined || isBroken} className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full w-max min-w-full items-center justify-center">
          {url !== undefined && (
            <img src={url} alt={path} draggable={false} hidden={natural === undefined} style={{ ...CHECKERBOARD, width: base.width * scale, height: base.height * scale }}
              onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setBrokenUrl(url)} />
          )}
        </div>
      </div>
    </>
  );
}
