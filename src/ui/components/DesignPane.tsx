import { MessageCircleIcon } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import { matches } from '../../shortcuts';
import type { DesignTarget, DesignViewport, UnpinnedDesignAnchor } from '../../types';
import { DesignComposer, saveComment } from '@/components/DesignComposer';
import { composerStyle, DesignPins } from '@/components/DesignPins';
import { DesignComments, TOGGLE_ITEM, TOGGLE_TRACK } from '@/components/DesignComments';
import { SUBMIT_KEY } from '@/components/DiffFooter';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type DesignCommentsModel, useDesignComments } from '@/hooks/use-design-comments';
import { anchorsOf, bridgeData, type CommentCanvas, type PinRects, useCommentCanvas, useDesignPins } from '@/hooks/use-design-pins';
import { readVersion, useFileVersion } from '@/hooks/use-file-version';
import { type DesignZoom, isViewport, useDesignZoom, type Viewport, VIEWPORT_PX, VIEWPORTS } from '@/hooks/use-design-zoom';
import { t } from '@/i18n';
import type { Activity, TaskActivity } from '@/lib/activities';
import { getJson } from '@/lib/api';
import { clockOf, type DesignTheme, nextPin } from '@/lib/design-comments';
import { isMac, isTextField } from '@/lib/shortcut-bindings';
import { STATUS_DOT } from '@/lib/status';

// The design pane (#109): one Hive design (.hv.html) of an activity, served by the design frame route (#108) into a sandboxed frame on the
// handoff's canvas, under its preview bar. Read only: the agent writes the file.

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
const WITH_PANEL = 'minmax(0,1fr) 300px'; // the handoff's §2: the canvas, then the 300 px comments panel
const CANVAS_ONLY = 'minmax(0,1fr)';

const baseName = (path: string): string => path.split('/').at(-1) ?? path;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// The Hive's theme as the pane mounts (lib/theme.ts writes it on <html>): the design starts in it, and a toggle never writes it back
const pageTheme = (): DesignTheme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

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
      const data = bridgeData(event, frame.current);
      if (data === undefined) return;
      const { type, height: next } = data;
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

interface CommentsToggle { count: number; isShown: boolean; onToggle(): void; isCommenting: boolean; onComment(): void }
interface BarProps { path: string; name: string; reloadedAt?: Date; viewport: Viewport; theme: DesignTheme; zoom: DesignZoom; comments?: CommentsToggle; onViewport(next: Viewport): void; onTheme(next: DesignTheme): void }

// The bar's item 7 (#114): on, an --empty border on --accent; off, the border alone
function CommentModeButton({ isOn, onToggle }: { isOn: boolean; onToggle(): void }) {
  return (
    <Button type="button" size="xs" variant="ghost" aria-pressed={isOn} title={t('design.comment.toggle')} onClick={onToggle} className={`shrink-0 border ${isOn ? 'border-empty bg-accent text-foreground' : 'text-muted-foreground'}`}>
      {t('design.comment')}
    </Button>
  );
}

// The bar's item 8 (#113): message-circle and the open count; --accent with --foreground while the panel shows, muted while hidden
function CommentsButton({ count, isShown, onToggle }: CommentsToggle) {
  return (
    <Button type="button" size="xs" variant="ghost" aria-label={t('design.comments')} aria-pressed={isShown} title={t('design.comments.toggle')} onClick={onToggle} className={`shrink-0 tabular-nums ${isShown ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>
      <MessageCircleIcon className="size-3" />{count}
    </Button>
  );
}

// The handoff's preview bar (#109), items 1–5 and, on a task's pane, 7 (#114) and 8 (#113): 26 px, one line that hides what does not fit
function DesignBar({ path, name, reloadedAt, viewport, theme, zoom, comments, onViewport, onTheme }: BarProps) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-3 overflow-hidden border-b px-2.5 text-muted-foreground text-xs">
      <span title={path} className="min-w-0 flex-1 truncate font-mono">{path}</span>
      {reloadedAt && <ReloadedMark name={name} at={reloadedAt} />}
      <ToggleGroup type="single" size="xs" aria-label={t('design.viewport')} value={viewport} onValueChange={(next) => { if (isViewport(next)) onViewport(next); }} className={TOGGLE_TRACK}>
        {VIEWPORTS.map((item) => <ToggleGroupItem key={item} value={item} className={TOGGLE_ITEM}>{t(`design.viewport.${item}`)}</ToggleGroupItem>)}
      </ToggleGroup>
      <ZoomControl zoom={zoom} />
      <ToggleGroup type="single" size="xs" aria-label={t('design.theme')} value={theme} onValueChange={(next) => { if (next === 'dark' || next === 'light') onTheme(next); }} className={TOGGLE_TRACK}>
        {THEMES.map((item) => <ToggleGroupItem key={item} value={item} className={TOGGLE_ITEM}>{t(`design.theme.${item}`)}</ToggleGroupItem>)}
      </ToggleGroup>
      {comments && (
        <>
          <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />
          <CommentModeButton isOn={comments.isCommenting} onToggle={comments.onComment} />
          <CommentsButton {...comments} />
        </>
      )}
    </div>
  );
}

interface CanvasProps { canvas: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLIFrameElement | null>; url?: string; name: string; width: number; height: number; zoom: DesignZoom; reloads: number; isCommenting: boolean; children?: ReactNode }

// The canvas scrolls a box the zoomed frame's size, and the frame inside it keeps its own size and scales from its top-left corner: a
// transform alone leaves the layout box, so the canvas would not scroll to a zoomed frame's edges. The box does not clip (overflow visible)
function DesignCanvas({ canvas, frame, url, name, width, height, zoom, reloads, isCommenting, children }: CanvasProps) {
  const scale = zoom.zoom / FULL;
  // The bridge sets the crosshair inside the frame only (#112): the margin takes it here
  const cursor = zoom.isPanning ? 'grab' : (isCommenting ? 'crosshair' : undefined);
  return (
    <div ref={canvas} data-design-canvas onPointerDown={zoom.onPointerDown} style={{ ...DOTS, cursor }} className="min-h-0 flex-1 overflow-auto bg-background p-4">
      <div data-design-box style={{ width: width * scale, height: height * scale, boxShadow: FRAME_SHADOW }} className="relative mx-auto rounded-md">
        {url !== undefined && (
          <iframe
            key={reloads} ref={frame} src={url} title={name} sandbox="allow-scripts" width={width} height={height} className="block rounded-md border-0"
            style={{ transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: zoom.isPanning ? 'none' : undefined }}
          />
        )}
        {children}
      </div>
    </div>
  );
}

// A click on the bar or the canvas's margin puts the focus in the pane, so ⌘0 and Space reach it; a control still takes its own focus after
const focusPane = (event: ReactPointerEvent<HTMLElement>): void => {
  if (!event.currentTarget.contains(document.activeElement)) event.currentTarget.focus({ preventScroll: true });
};

// ⌘⇧↵ sends every draft (#113), only while the focus is in the pane: its section takes it, as ⌘0. The panel itself has no key: ⌘⌥C is openDiff on
// macOS. A hidden panel sends nothing: the user cannot see the drafts. True: taken
function takeSendKey(event: ReactKeyboardEvent<HTMLElement>, comments: DesignCommentsModel, isPanelShown: boolean): boolean {
  if (!isPanelShown || !matches(event.nativeEvent, SUBMIT_KEY, isMac())) return false;
  comments.sendAll();
  event.preventDefault();
  return true;
}

// C and Esc (#114), while the focus is in the pane and not in a field, with no modifier; the bridge's key message reaches the same takeKey
function takeCommentKey(event: ReactKeyboardEvent<HTMLElement>, canvas: CommentCanvas): boolean {
  const { key, metaKey, ctrlKey, altKey, shiftKey, target } = event;
  if (metaKey || ctrlKey || altKey || shiftKey || isTextField(target) || !canvas.takeKey(key)) return false;
  event.preventDefault();
  return true;
}

interface OverlayProps { model: DesignCommentsModel; canvas: CommentCanvas; rects: PinRects; percent: number; path: string; width: DesignViewport; theme: DesignTheme }

// The canvas's overlay (#114): the open pins always, the resolved ones while the panel lists them, and the composer while a target is aimed
function CommentOverlay({ model, canvas, rects, percent, path, width, theme }: OverlayProps) {
  const { target } = canvas;
  const scale = percent / FULL;
  const anchorOf = (aimed: DesignTarget): UnpinnedDesignAnchor => ({ ...aimed, path, viewport: width, theme });
  const items = canvas.isPanelShown && canvas.tab === 'resolved' ? [...model.open, ...model.resolved] : model.open;
  const pin = nextPin(model);
  // The composer closes once the server took the comment; a refusal keeps it open with its text
  const save = (isSend: boolean) => (text: string): void => {
    if (target !== undefined) void saveComment(model, anchorOf(target), text, isSend).then((isTaken) => { if (isTaken) canvas.closeIf(target); });
  };
  return (
    <>
      <DesignPins items={items} rects={rects} scale={scale} theme={theme} selected={canvas.selection?.id} editing={target && { target, pin }} onSelect={canvas.selectPin} />
      {target !== undefined && (
        <DesignComposer
          target={target} pin={pin} theme={theme} isBusy={model.isBusy} style={composerStyle(target.rect, scale, width * scale)}
          onAdd={save(false)} onSend={save(true)} onCancel={canvas.close}
        />
      )}
    </>
  );
}

// The pane itself (#109, #113): comments only on a task's
function DesignView({ activity, path, label, active, comments }: DesignPaneProps & { comments?: DesignCommentsModel }) {
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
  const marks = useCommentCanvas(comments);
  const pins = useDesignPins(frame, canvas, anchorsOf(comments), marks.isCommenting, { onAnchor: marks.aim, onKey: marks.takeKey });
  const height = useFrameMessages(frame, () => {
    pins.reload(); // the bridge keeps no anchor nor mode across a load (#112); before the theme, which the zoom test reads last
    postTheme(frame.current, theme); // the frame forgets the theme on every load
    if (reloads.take()) setReloadedAt(new Date());
  }) ?? width * FRAME_ASPECT;
  // An aimed rect was measured in the other theme or viewport: either change drops the composer
  const pickTheme = (next: DesignTheme): void => { setTheme(next); postTheme(frame.current, next); marks.close(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!takeCommentKey(event, marks) && (comments === undefined || !takeSendKey(event, comments, marks.isPanelShown))) zoom.onKeyDown(event);
  };
  return (
    <section data-design-pane aria-label={label} tabIndex={-1} onPointerDownCapture={focusPane} onKeyDown={onKeyDown} onKeyUp={zoom.onKeyUp} onBlur={zoom.onBlur} style={active ? SHOWN : COLLAPSED} className="flex min-h-0 min-w-0 flex-col overflow-hidden outline-none">
      <DesignBar
        path={path} name={name} reloadedAt={reloadedAt} viewport={viewport} theme={theme} zoom={zoom} onViewport={(next) => { setViewport(next); marks.close(); }} onTheme={pickTheme}
        comments={comments && { count: comments.open.length, isShown: marks.isPanelShown, onToggle: () => marks.setPanelShown(!marks.isPanelShown), isCommenting: marks.isCommenting, onComment: marks.toggle }}
      />
      <div style={{ gridTemplateColumns: comments !== undefined && marks.isPanelShown ? WITH_PANEL : CANVAS_ONLY }} className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-px bg-border">
        {mint.status === 'error'
          ? <p role="alert" className="bg-background p-3 text-destructive text-xs">{mint.message}</p>
          : (
            <DesignCanvas canvas={canvas} frame={frame} url={mint.status === 'ready' ? mint.url : undefined} name={name} width={width} height={height} zoom={zoom} reloads={reloads.count} isCommenting={marks.isCommenting}>
              {comments && <CommentOverlay model={comments} canvas={marks} rects={pins.rects} percent={zoom.zoom} path={path} width={width} theme={theme} />}
            </DesignCanvas>
          )}
        {comments !== undefined && marks.isPanelShown && (
          <DesignComments
            model={comments} tab={marks.tab} selection={marks.selection} rects={pins.rects} onTab={marks.setTab} onHide={() => marks.setPanelShown(false)}
            onSelect={(id) => { marks.selectItem(id); pins.scrollTo(id); }}
          />
        )}
      </div>
    </section>
  );
}

// A task's pane (#113): its review holds the comments. A local activity has none, so its pane has no panel, button nor send key
function TaskDesignPane(props: DesignPaneProps & { activity: TaskActivity }) {
  const comments = useDesignComments(props.activity, props.path);
  return <DesignView {...props} comments={comments} />;
}

/** The design pane (#109): the preview bar over the canvas, and on a task's pane the comments panel beside it (#113). No PaneHeader above
 *  it: the bar names the path. Collapsed like PreviewPane while another tab shows. */
export function DesignPane(props: DesignPaneProps) {
  const { activity } = props;
  return activity.kind === 'task' ? <TaskDesignPane {...props} activity={activity} /> : <DesignView {...props} />;
}
