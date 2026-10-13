import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import { matches } from '../../shortcuts';
import type { DesignTarget, DesignViewport, UnpinnedDesignAnchor } from '../../types';
import { DesignComposer, saveComment } from '@/components/DesignComposer';
import { composerStyle, DesignPins } from '@/components/DesignPins';
import { DesignBar } from '@/components/DesignBar';
import { DesignComments } from '@/components/DesignComments';
import { SUBMIT_KEY } from '@/components/DiffFooter';
import { type DesignCommentsModel, useDesignComments } from '@/hooks/use-design-comments';
import { anchorsOf, bridgeData, type CommentCanvas, type PinRects, type PinsBridge, useCommentCanvas, useDesignPins } from '@/hooks/use-design-pins';
import { readVersion, useFileVersion } from '@/hooks/use-file-version';
import { type DesignZoom, useDesignZoom, type Viewport, VIEWPORT_PX } from '@/hooks/use-design-zoom';
import type { Activity, TaskActivity } from '@/lib/activities';
import { getJson } from '@/lib/api';
import { type DesignTheme, nextPin } from '@/lib/design-comments';
import { isMac, isTextField } from '@/lib/shortcut-bindings';

// The design pane (#109): one Hive design (.hv.html) of an activity, served by the design frame route (#108) into a sandboxed frame on the
// handoff's canvas, under its preview bar. Read only: the agent writes the file.

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
  const anchorOf = (aimed: DesignTarget): UnpinnedDesignAnchor => ({ ...aimed, path, viewport: width, theme, tweaks: {} });
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

interface DesignViewModel {
  name: string; canvas: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLIFrameElement | null>;
  viewport: Viewport; theme: DesignTheme; width: DesignViewport; height: number; mint: Mint; reloads: Reloads; reloadedAt?: Date;
  zoom: DesignZoom; marks: CommentCanvas; pins: PinsBridge;
  pickViewport(next: Viewport): void; pickTheme(next: DesignTheme): void; selectComment(id: string): void;
}

// The pane's state (#109, #113, #114): one owner for the bar, the canvas, its overlay and the panel
function useDesignView({ activity, path, active }: DesignPaneProps, comments?: DesignCommentsModel): DesignViewModel {
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
  return {
    name: baseName(path), canvas, frame, viewport, theme, width, height, mint, reloads, reloadedAt, zoom, marks, pins, pickTheme,
    pickViewport: (next) => { setViewport(next); marks.close(); },
    selectComment: (id) => { marks.selectItem(id); pins.scrollTo(id); },
  };
}

// The pane itself (#109, #113): comments only on a task's
function DesignView({ comments, ...props }: DesignPaneProps & { comments?: DesignCommentsModel }) {
  const { path, label, active } = props;
  const view = useDesignView(props, comments);
  const { name, canvas, frame, viewport, theme, width, height, mint, reloads, reloadedAt, zoom, marks, pins } = view;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!takeCommentKey(event, marks) && (comments === undefined || !takeSendKey(event, comments, marks.isPanelShown))) zoom.onKeyDown(event);
  };
  return (
    <section data-design-pane aria-label={label} tabIndex={-1} onPointerDownCapture={focusPane} onKeyDown={onKeyDown} onKeyUp={zoom.onKeyUp} onBlur={zoom.onBlur} style={active ? SHOWN : COLLAPSED} className="flex min-h-0 min-w-0 flex-col overflow-hidden outline-none">
      <DesignBar
        path={path} name={name} reloadedAt={reloadedAt} viewport={viewport} theme={theme} zoom={zoom} onViewport={view.pickViewport} onTheme={view.pickTheme}
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
            onSelect={view.selectComment}
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
