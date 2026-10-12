import { type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { readVersion, useFileVersion } from '@/hooks/use-file-version';
import { type DesignZoom, isViewport, useDesignZoom, type Viewport, VIEWPORT_PX, VIEWPORTS } from '@/hooks/use-design-zoom';
import { t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import { getJson } from '@/lib/api';
import { STATUS_DOT } from '@/lib/status';

// The design pane (#109): one Hive design (.hv.html) of an activity, served by the design frame route (#108) into a sandboxed frame on the
// handoff's canvas, under its preview bar. Read only: the agent writes the file.

type DesignTheme = 'dark' | 'light';
const THEMES: readonly DesignTheme[] = ['dark', 'light'];
type Mint = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; url: string };

/** label: `{task label} · Design {file name}`, the section's name (#109). */
export interface DesignPaneProps { activity: Activity; path: string; label: string; active: boolean }

const FRAME_ASPECT = 0.625; // the frame's height before the bridge's first size: 800 px at desktop
const FULL = 100;
const MAX_FRAME_HEIGHT = 100_000; // a design may post any size: past this, the canvas's layout would choke
const SHOWN: CSSProperties = { flex: '1 1 0%', opacity: 1, pointerEvents: 'auto' };
const COLLAPSED: CSSProperties = { flex: '0 0 0%', opacity: 0, pointerEvents: 'none' }; // mounted: a tab switch never reloads the frame
const DOTS: CSSProperties = { backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)', backgroundSize: '16px 16px' };
const FRAME_SHADOW = '0 0 0 1px var(--border), 0 4px 12px rgb(0 0 0 / .45)';
const TRACK = 'shrink-0 rounded-md bg-card p-0.5';
const ITEM = 'h-5 px-1.5 text-xs data-[state=on]:bg-accent data-[state=on]:text-foreground';

const baseName = (path: string): string => path.split('/').at(-1) ?? path;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// The Hive's theme as the pane mounts (lib/theme.ts writes it on <html>): the design starts in it, and a toggle never writes it back
const pageTheme = (): DesignTheme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
// HH:MM in the viewer's locale, 24 h as the handoff writes it
const clockOf = (at: Date): string => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The mint route of an activity's design (#108). */
export const designFrameRoute = (activityId: string, path: string): string =>
  `/activities/${encodeURIComponent(activityId)}/design-frame?${new URLSearchParams({ path })}`;

// The frame's URL, minted once per mounted pane: the route's token holds for the whole boot. A refusal's words stay in the pane, no toast
function useMint(activityId: string, path: string): Mint {
  const [mint, setMint] = useState<Mint>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    getJson<{ url: string }>(designFrameRoute(activityId, path)).then(
      ({ url }) => { if (live) setMint({ status: 'ready', url }); },
      (err: unknown) => { if (live) setMint({ status: 'error', message: messageOf(err) }); },
    );
    return () => { live = false; };
  }, [activityId, path]);
  return mint;
}

interface Reloads { count: number; take(): boolean }

// The frame's reloads (#109). No watcher: the 2 s poll. Its first version is remembered; a later different one reloads the frame (a new React
// key, the same URL) and waits for the frame's next ready to be marked, since the protocol has no reloaded message (#108). A file gone (null)
// changes nothing until it comes back
function useReloads(activityId: string, path: string, isShown: boolean): Reloads {
  const [count, setCount] = useState(0);
  const seen = useRef<string | undefined>(undefined);
  const isPending = useRef(false);
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
    if (seen.current !== undefined) {
      isPending.current = true;
      setCount((n) => n + 1);
    }
    seen.current = version;
  });
  const take = (): boolean => {
    const was = isPending.current;
    isPending.current = false;
    return was;
  };
  return { count, take };
}

// The handoff's §2.2: after the first reload, ● in --working and the time; it stays until the tab unmounts, updated on each reload
function ReloadedMark({ name, at }: { name: string; at: Date }) {
  const time = clockOf(at);
  return (
    <span title={t('design.reloaded', { file: name, time })} className="flex shrink-0 items-center gap-1 tabular-nums">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${STATUS_DOT.working}`} />{time}
    </span>
  );
}

// The bridge's messages (#108), only from this pane's frame and only in the protocol's shape: ready, the frame loaded (again); size, its
// content's height, which the frame takes so the canvas scrolls rather than the frame. The design itself may post too: anything else is dropped
function useFrameMessages(frame: RefObject<HTMLIFrameElement | null>, onReady: () => void): number | undefined {
  const [height, setHeight] = useState<number>();
  const ready = useEffectEvent(onReady);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const { data } = event;
      if (event.source === null || event.source !== frame.current?.contentWindow || typeof data !== 'object' || data === null) return;
      const { hive, type, height: next } = data as Record<string, unknown>;
      if (hive !== 'design') return;
      if (type === 'ready') ready();
      else if (type === 'size' && typeof next === 'number' && Number.isFinite(next) && next >= 0) setHeight(Math.min(next, MAX_FRAME_HEIGHT));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
  return height;
}

// '*': the sandboxed frame's origin is opaque, so no named origin matches it; a theme is nothing to hide
const postTheme = (frame: HTMLIFrameElement | null, theme: DesignTheme): void => {
  frame?.contentWindow?.postMessage({ hive: 'design', type: 'theme', theme }, '*');
};

function ZoomControl({ zoom }: { zoom: DesignZoom }) {
  return (
    <span className="flex shrink-0 items-center">
      <Button type="button" size="icon-xs" variant="ghost" aria-label={t('design.zoomOut')} onClick={() => zoom.zoomBy(-1)}>−</Button>
      <span title={t('design.fit')} className="w-10 text-center tabular-nums">{`${zoom.zoom}%`}</span>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={t('design.zoomIn')} onClick={() => zoom.zoomBy(1)}>+</Button>
    </span>
  );
}

interface BarProps { path: string; name: string; reloadedAt?: Date; viewport: Viewport; theme: DesignTheme; zoom: DesignZoom; onViewport(next: Viewport): void; onTheme(next: DesignTheme): void }

// The handoff's preview bar, items 1–5 (#109): 26 px, one line that hides what does not fit. Comments and their toggle are 3.3's
function DesignBar({ path, name, reloadedAt, viewport, theme, zoom, onViewport, onTheme }: BarProps) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-3 overflow-hidden border-b px-2.5 text-muted-foreground text-xs">
      <span title={path} className="min-w-0 flex-1 truncate font-mono">{path}</span>
      {reloadedAt && <ReloadedMark name={name} at={reloadedAt} />}
      <ToggleGroup type="single" size="xs" aria-label={t('design.viewport')} value={viewport} onValueChange={(next) => { if (isViewport(next)) onViewport(next); }} className={TRACK}>
        {VIEWPORTS.map((item) => <ToggleGroupItem key={item} value={item} className={ITEM}>{t(`design.viewport.${item}`)}</ToggleGroupItem>)}
      </ToggleGroup>
      <ZoomControl zoom={zoom} />
      <ToggleGroup type="single" size="xs" aria-label={t('design.theme')} value={theme} onValueChange={(next) => { if (next === 'dark' || next === 'light') onTheme(next); }} className={TRACK}>
        {THEMES.map((item) => <ToggleGroupItem key={item} value={item} className={ITEM}>{t(`design.theme.${item}`)}</ToggleGroupItem>)}
      </ToggleGroup>
    </div>
  );
}

interface CanvasProps { canvas: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLIFrameElement | null>; url?: string; name: string; width: number; height: number; zoom: DesignZoom; reloads: number }

// The canvas scrolls a box the zoomed frame's size, and the frame inside it keeps its own size and scales from its top-left corner: a
// transform alone leaves the layout box, so the canvas would not scroll to a zoomed frame's edges. The box does not clip (overflow visible)
function DesignCanvas({ canvas, frame, url, name, width, height, zoom, reloads }: CanvasProps) {
  const scale = zoom.zoom / FULL;
  return (
    <div ref={canvas} data-design-canvas onPointerDown={zoom.onPointerDown} style={{ ...DOTS, cursor: zoom.isPanning ? 'grab' : undefined }} className="min-h-0 flex-1 overflow-auto bg-background p-4">
      <div data-design-box style={{ width: width * scale, height: height * scale, boxShadow: FRAME_SHADOW }} className="mx-auto rounded-md">
        {url !== undefined && (
          <iframe
            key={reloads} ref={frame} src={url} title={name} sandbox="allow-scripts" width={width} height={height} className="block rounded-md border-0"
            style={{ transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: zoom.isPanning ? 'none' : undefined }}
          />
        )}
      </div>
    </div>
  );
}

// A click on the bar or the canvas's margin puts the focus in the pane, so ⌘0 and Space reach it; a control still takes its own focus after
const focusPane = (event: ReactPointerEvent<HTMLElement>): void => {
  if (!event.currentTarget.contains(document.activeElement)) event.currentTarget.focus({ preventScroll: true });
};

/** The design pane (#109): the preview bar over the canvas. No PaneHeader above it: the bar names the path. Collapsed like PreviewPane
 *  while another tab shows. */
export function DesignPane({ activity, path, label, active }: DesignPaneProps) {
  const name = baseName(path);
  const canvas = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [theme, setTheme] = useState<DesignTheme>(pageTheme);
  const mint = useMint(activity.activity.id, path);
  const reloads = useReloads(activity.activity.id, path, active);
  const [reloadedAt, setReloadedAt] = useState<Date>();
  const width = VIEWPORT_PX[viewport];
  const zoom = useDesignZoom(canvas, width, active && mint.status !== 'error');
  const height = useFrameMessages(frame, () => {
    postTheme(frame.current, theme); // the frame forgets the theme on every load
    if (reloads.take()) setReloadedAt(new Date());
  }) ?? width * FRAME_ASPECT;
  const pickTheme = (next: DesignTheme): void => {
    setTheme(next);
    postTheme(frame.current, next);
  };
  return (
    <section aria-label={label} tabIndex={-1} onPointerDownCapture={focusPane} onKeyDown={zoom.onKeyDown} onKeyUp={zoom.onKeyUp} onBlur={zoom.onBlur} style={active ? SHOWN : COLLAPSED} className="flex min-h-0 min-w-0 flex-col overflow-hidden outline-none">
      <DesignBar path={path} name={name} reloadedAt={reloadedAt} viewport={viewport} theme={theme} zoom={zoom} onViewport={setViewport} onTheme={pickTheme} />
      {mint.status === 'error'
        ? <p role="alert" className="p-3 text-destructive text-xs">{mint.message}</p>
        : <DesignCanvas canvas={canvas} frame={frame} url={mint.status === 'ready' ? mint.url : undefined} name={name} width={width} height={height} zoom={zoom} reloads={reloads.count} />}
    </section>
  );
}
