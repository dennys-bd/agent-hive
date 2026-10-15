import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import { matches } from '../../shortcuts';
import { type DeclaredViewport, DESIGN_VIEWPORT_PX, type DesignTarget, type DesignTweakValue, type DesignViewport, type UnpinnedDesignAnchor } from '../../types';
import { DesignComposer, saveComment } from '@/components/DesignComposer';
import { composerStyle, DesignPins } from '@/components/DesignPins';
import { DesignBar } from '@/components/DesignBar';
import { DesignComments } from '@/components/DesignComments';
import { DesignTweaks } from '@/components/DesignTweaks';
import { SUBMIT_KEY } from '@/components/DiffFooter';
import { type DesignCommentsModel, useDesignComments } from '@/hooks/use-design-comments';
import { anchorsOf, bridgeData, type CommentCanvas, type PinRects, type PinsBridge, useCommentCanvas, useDesignPins } from '@/hooks/use-design-pins';
import { type DesignTweaks as DesignTweaksModel, type TweakBlock, useDesignTweaks } from '@/hooks/use-design-tweaks';
import { readVersion, useFileVersion } from '@/hooks/use-file-version';
import { type DesignZoom, useDesignZoom } from '@/hooks/use-design-zoom';
import type { Activity } from '@/lib/activities';
import { getJson } from '@/lib/api';
import { type DesignState, type DesignTheme, isOnState, nextPin } from '@/lib/design-comments';
import { isMac, isTextField } from '@/lib/shortcut-bindings';

// The design pane (#109): one Hive design (.hv.html) of an activity, served by the design frame route (#108) into a sandboxed frame on the
// handoff's canvas, under its preview bar. Read only: the agent writes the file.

type Mint = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; url: string };

/** label: `{task label} · Design {file name}`, the section's name (#109). */
export interface DesignPaneProps { activity: Activity; path: string; label: string; active: boolean }

const FRAME_ASPECT = 0.625; // the frame's height before the bridge's first size: 800 px at 1280 wide
const FULL = 100;
const MAX_FRAME_PX = 100_000; // a design may post any size: past this, the canvas's layout would choke
const SHOWN: CSSProperties = { flex: '1 1 0%', opacity: 1, pointerEvents: 'auto' };
const COLLAPSED: CSSProperties = { flex: '0 0 0%', opacity: 0, pointerEvents: 'none' }; // mounted: a tab switch never reloads the frame
const DOTS: CSSProperties = { backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)', backgroundSize: '16px 16px' };
const FRAME_SHADOW = '0 0 0 1px var(--border), 0 4px 12px rgb(0 0 0 / .45)';
const WITH_PANEL = 'minmax(0,1fr) 300px'; // the handoff's §2: the canvas, then the 300 px comments panel
const CANVAS_ONLY = 'minmax(0,1fr)';
const NATURAL_MIN = DESIGN_VIEWPORT_PX.mobile; // an empty page measures 0
const NATURAL_MAX = DESIGN_VIEWPORT_PX.desktop; // a fluid text page measures ~16,900 px; also natural's width before the first measure

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
// content's height, its overflow width (#241) and its natural width (#341), which the frame takes so the canvas scrolls rather than the
// frame. The design itself may post too: anything else is dropped
interface FrameSize { height?: number; width?: number; natural?: number }
const isFramePx = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function useFrameMessages(frame: RefObject<HTMLIFrameElement | null>, onReady: () => void): [FrameSize, () => void] {
  const [size, setSize] = useState<FrameSize>({});
  const ready = useEffectEvent(onReady);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = bridgeData(event, frame.current);
      if (data === undefined) return;
      const { type, height, width, natural } = data;
      if (type === 'ready') ready();
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
  return [size, () => setSize(({ height, natural }) => ({ height, natural }))];
}

// natural (#341): the content's measured width, held to mobile–desktop. A fixed viewport: its width, or a window screen's wider overflow (#241)
const frameWidthOf = (viewport: DesignViewport, size: FrameSize): number =>
  (viewport === 'natural'
    ? Math.min(NATURAL_MAX, Math.max(NATURAL_MIN, size.natural ?? NATURAL_MAX))
    : Math.max(DESIGN_VIEWPORT_PX[viewport], size.width ?? 0));

// The switch's list (#341): natural, the viewports the screen declares, then the current one when the screen no longer declares it, so a
// comment pinned there can be reopened
function switchOf(declared: readonly DeclaredViewport[], current: DesignViewport): DesignViewport[] {
  const list: DesignViewport[] = ['natural', ...declared];
  return list.includes(current) ? list : [...list, current];
}

// '*': the sandboxed frame's origin is opaque, so no named origin matches it; a theme is nothing to hide
const postTheme = (frame: HTMLIFrameElement | null, theme: DesignTheme): void => {
  frame?.contentWindow?.postMessage({ hive: 'design', type: 'theme', theme }, '*');
};

interface CanvasProps { canvas: RefObject<HTMLDivElement | null>; box: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLIFrameElement | null>; url?: string; name: string; width: number; height: number; zoom: DesignZoom; reloads: number; isCommenting: boolean; children?: ReactNode }

// The bridge sets the crosshair inside the frame only (#112): the margin takes it here. grabbing while a pan is under way (#346)
function canvasCursor(zoom: DesignZoom, isCommenting: boolean): string | undefined {
  if (zoom.isDragging) return 'grabbing';
  if (zoom.isPanning) return 'grab';
  return isCommenting ? 'crosshair' : undefined;
}

// The canvas scrolls a box the zoomed frame's size, and the frame inside it keeps its own size and scales from its top-left corner: a
// transform alone leaves the layout box, so the canvas would not scroll to a zoomed frame's edges. The box does not clip (overflow visible).
// While Space is held or a pan is under way the frame is off the pointer, so the drag's moves reach the pane's window (#346)
function DesignCanvas({ canvas, box, frame, url, name, width, height, zoom, reloads, isCommenting, children }: CanvasProps) {
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

// A click on the bar or the canvas's margin puts the focus in the pane, so ⌘0 and Space reach it; a control still takes its own focus after.
// React bubbles a portal's pointer-down here too: one inside the tweaks panel must not pull the focus out of it, or Radix closes it (#342)
const focusPane = (event: ReactPointerEvent<HTMLElement>): void => {
  const pane = event.currentTarget;
  if (event.target instanceof Node && pane.contains(event.target) && !pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
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

interface OverlayProps { model: DesignCommentsModel; canvas: CommentCanvas; rects: PinRects; percent: number; path: string; state: DesignState; frameWidth: number }

// The canvas's overlay (#114): the open pins always, the resolved ones while the panel lists them, and the composer while a target is aimed
function CommentOverlay({ model, canvas, rects, percent, path, state, frameWidth }: OverlayProps) {
  const { theme } = state;
  const { target } = canvas;
  const scale = percent / FULL;
  const anchorOf = (aimed: DesignTarget): UnpinnedDesignAnchor => ({ ...aimed, path, viewport: state.viewport, theme, tweaks: state.tweaks });
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
          target={target} pin={pin} theme={theme} isBusy={model.isBusy} style={composerStyle(target.rect, scale, frameWidth * scale)}
          onAdd={save(false)} onSend={save(true)} onCancel={canvas.close}
        />
      )}
    </>
  );
}

interface DesignViewModel {
  name: string; canvas: RefObject<HTMLDivElement | null>; box: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLIFrameElement | null>;
  viewport: DesignViewport; viewports: DesignViewport[]; theme: DesignTheme; state: DesignState; width: number; height: number; mint: Mint; reloads: Reloads; reloadedAt?: Date;
  zoom: DesignZoom; marks: CommentCanvas; pins: PinsBridge; tweaks: DesignTweaksModel;
  pickViewport(next: DesignViewport): void; pickTheme(next: DesignTheme): void; pickTweak(name: string, value: DesignTweakValue): void; selectComment(id: string): void;
}

// The pane's state (#109, #113, #114): one owner for the bar, the canvas, its overlay and the panel
function useDesignView({ activity, path, active }: DesignPaneProps, comments: DesignCommentsModel): DesignViewModel {
  const canvas = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null); // the zoom's anchor reference (#346)
  const frame = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<DesignViewport>('natural');
  const [theme, setTheme] = useState<DesignTheme>(pageTheme);
  const mint = useMint(activity.activity.id, path);
  const reloads = useReloads(activity.activity.id, path, active);
  const [reloadedAt, setReloadedAt] = useState<Date>();
  const tweaks = useDesignTweaks(frame);
  const marks = useCommentCanvas(comments);
  const state: DesignState = { viewport, theme, schema: tweaks.schema, tweaks: tweaks.values };
  const pins = useDesignPins(frame, canvas, anchorsOf(comments, state), marks.isCommenting, { onAnchor: marks.aim, onKey: marks.takeKey });
  const [size, forgetWidth] = useFrameMessages(frame, () => {
    pins.reload(); // the bridge keeps no anchor nor mode across a load (#112); before the theme, which the zoom test reads last
    postTheme(frame.current, theme); // the frame forgets the theme and the tweaks on every load
    tweaks.repost();
    if (reloads.take()) setReloadedAt(new Date());
  });
  const width = frameWidthOf(viewport, size);
  const zoom = useDesignZoom(canvas, box, width, active && mint.status !== 'error');
  // An aimed rect was measured in another theme, viewport or set of tweaks: any change drops the composer
  const pickTheme = (next: DesignTheme): void => { setTheme(next); postTheme(frame.current, next); marks.close(); };
  const pickViewport = (next: DesignViewport): void => { setViewport(next); forgetWidth(); marks.close(); };
  // A comment chosen in the list reopens on the state it was made on (#241), then scrolls to it (#114)
  const selectComment = (id: string): void => {
    marks.selectItem(id);
    const anchor = [...comments.open, ...comments.resolved].find((c) => c.id === id)?.anchor;
    if (anchor !== undefined && !isOnState(anchor, state)) {
      pickViewport(anchor.viewport);
      if (anchor.theme !== theme) pickTheme(anchor.theme);
      tweaks.apply(anchor.tweaks);
    }
    pins.scrollTo(id);
  };
  const pickTweak = (name: string, value: DesignTweakValue): void => { tweaks.set(name, value); marks.close(); };
  return {
    name: baseName(path), canvas, box, frame, viewport, viewports: switchOf(tweaks.viewports, viewport), theme, state, width, height: size.height ?? width * FRAME_ASPECT, mint, reloads, reloadedAt, zoom, marks, pins, tweaks, pickTheme, pickTweak,
    pickViewport,
    selectComment,
  };
}

// No row for a valid block with no tweak: the skeleton ships one, and a row of only "More…" would say nothing (#241)
const hasTweaksRow = (block: TweakBlock): block is Exclude<TweakBlock, { status: 'none' }> =>
  block.status === 'invalid' || (block.status === 'ok' && block.schema.length > 0);

// The pane itself (#109, #113): every activity's has its comments, a local one's in its workspace's review (#345)
function DesignView({ comments, ...props }: DesignPaneProps & { comments: DesignCommentsModel }) {
  const { path, label, active } = props;
  const view = useDesignView(props, comments);
  const { name, canvas, box, frame, viewport, theme, width, height, mint, reloads, reloadedAt, zoom, marks, pins } = view;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!takeCommentKey(event, marks) && !takeSendKey(event, comments, marks.isPanelShown)) zoom.onKeyDown(event);
  };
  return (
    <section data-design-pane aria-label={label} tabIndex={-1} onPointerDownCapture={focusPane} onKeyDown={onKeyDown} onKeyUp={zoom.onKeyUp} onBlur={zoom.onBlur} style={active ? SHOWN : COLLAPSED} className="flex min-h-0 min-w-0 flex-col overflow-hidden outline-none">
      <DesignBar
        path={path} name={name} reloadedAt={reloadedAt} viewport={viewport} viewports={view.viewports} theme={theme} zoom={zoom} onViewport={view.pickViewport} onTheme={view.pickTheme}
        comments={{ count: comments.open.length, isShown: marks.isPanelShown, onToggle: () => marks.setPanelShown(!marks.isPanelShown), isCommenting: marks.isCommenting, onComment: marks.toggle }}
      />
      {hasTweaksRow(view.tweaks.block) && <DesignTweaks block={view.tweaks.block} values={view.tweaks.values} onChange={view.pickTweak} />}
      <div style={{ gridTemplateColumns: marks.isPanelShown ? WITH_PANEL : CANVAS_ONLY }} className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-px bg-border">
        {mint.status === 'error'
          ? <p role="alert" className="bg-background p-3 text-destructive text-xs">{mint.message}</p>
          : (
            <DesignCanvas canvas={canvas} box={box} frame={frame} url={mint.status === 'ready' ? mint.url : undefined} name={name} width={width} height={height} zoom={zoom} reloads={reloads.count} isCommenting={marks.isCommenting}>
              <CommentOverlay model={comments} canvas={marks} rects={pins.rects} percent={zoom.zoom} path={path} state={view.state} frameWidth={width} />
            </DesignCanvas>
          )}
        {marks.isPanelShown && (
          <DesignComments
            model={comments} tab={marks.tab} selection={marks.selection} rects={pins.rects} onTab={marks.setTab} onHide={() => marks.setPanelShown(false)}
            onSelect={view.selectComment}
          />
        )}
      </div>
    </section>
  );
}

/** The design pane (#109): the preview bar over the canvas, and the comments panel beside it (#113), a task's or a local activity's (#345).
 *  No PaneHeader above it: the bar names the path. Collapsed like PreviewPane while another tab shows. */
export function DesignPane(props: DesignPaneProps) {
  const comments = useDesignComments(props.activity, props.path);
  return <DesignView {...props} comments={comments} />;
}
