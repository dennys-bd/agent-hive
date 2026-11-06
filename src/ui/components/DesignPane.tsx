import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useRef, useState } from 'react';
import { matches } from '../../shortcuts';
import type { DesignTarget, DesignTweakValue, DesignViewport, UnpinnedDesignAnchor } from '../../types';
import { DesignComposer, saveComment } from '@/components/DesignComposer';
import { composerStyle, DesignPins } from '@/components/DesignPins';
import { DesignBar } from '@/components/DesignBar';
import { DesignComments } from '@/components/DesignComments';
import { DesignTweaks } from '@/components/DesignTweaks';
import { SUBMIT_KEY } from '@/components/DiffFooter';
import { type DesignCommentsModel, useDesignComments } from '@/hooks/use-design-comments';
import { anchorsOf, type CommentCanvas, type PinRects, type PinsBridge, useCommentCanvas, useDesignPins } from '@/hooks/use-design-pins';
import { type DesignTweaks as DesignTweaksModel, type TweakBlock, useDesignTweaks } from '@/hooks/use-design-tweaks';
import { inScreenFolder, useFrameParts } from '@/hooks/use-design-parts';
import { DesignCanvas, designFrameRoute, FRAME_ASPECT, FULL, frameWidthOf, type Mint, pageTheme, postTheme, type Reloads, switchOf, useFrameMessages, useFrameZoom, useMint, useReloads } from '@/components/design-frame';
import { type DesignZoom, useDesignZoom } from '@/hooks/use-design-zoom';
import type { Activity } from '@/lib/activities';
import { type DesignState, type DesignTheme, isOnState, nextPin } from '@/lib/design-comments';
import { isMac, isTextField } from '@/lib/shortcut-bindings';
import { baseName } from '../../base-name';

// The design pane (#109): one Hive design (.hv.html) of an activity, served by the design frame route (#108) into a sandboxed frame on the
// handoff's canvas, under its preview bar. Read only: the agent writes the file.

/** label: `{task label} · Design {file name}`, the section's name (#109). */
export interface DesignPaneProps { activity: Activity; path: string; label: string; active: boolean }

const WITH_PANEL = 'minmax(0,1fr) 300px'; // the handoff's §2: the canvas, then the 300 px comments panel
const CANVAS_ONLY = 'minmax(0,1fr)';


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

// #421: the bridge names a part from the screen's folder; the comment carries it from the activity, as it does the screen's own path
const fromActivity = (aimed: DesignTarget, path: string): DesignTarget =>
  (aimed.kind === 'element' && aimed.part !== undefined ? { ...aimed, part: inScreenFolder(path, aimed.part) } : aimed);

interface OverlayProps { model: DesignCommentsModel; canvas: CommentCanvas; rects: PinRects; percent: number; path: string; state: DesignState; frameWidth: number }

// The canvas's overlay (#114): the open pins always, the resolved ones while the panel lists them, and the composer while a target is aimed
function CommentOverlay({ model, canvas, rects, percent, path, state, frameWidth }: OverlayProps) {
  const { theme } = state;
  const { target } = canvas;
  const scale = percent / FULL;
  const anchorOf = (aimed: DesignTarget): UnpinnedDesignAnchor => ({ ...fromActivity(aimed, path), path, viewport: state.viewport, theme, tweaks: state.tweaks });
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
  const mint = useMint(designFrameRoute(activity.activity.id, path));
  const parts = useFrameParts(frame);
  const reloads = useReloads(activity.activity.id, path, parts, active);
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
  useFrameZoom(frame, zoom);
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
  const { path, label } = props;
  const view = useDesignView(props, comments);
  const { name, canvas, box, frame, viewport, theme, width, height, mint, reloads, reloadedAt, zoom, marks, pins } = view;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!takeCommentKey(event, marks) && !takeSendKey(event, comments, marks.isPanelShown)) zoom.onKeyDown(event);
  };
  return (
    // the search's focus reads the pane as its file (#697): Git: Open Changes is offered over a design (#675)
    <section data-design-pane data-file-activity={props.activity.activity.id} data-file-path={path} aria-label={label} tabIndex={-1} onPointerDownCapture={focusPane} onKeyDown={onKeyDown} onKeyUp={zoom.onKeyUp} onBlur={zoom.onBlur} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none">
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
 *  No PaneHeader above it: the bar names the path. Hidden by the design layer while its tab is not shown (#533). */
export function DesignPane(props: DesignPaneProps) {
  const comments = useDesignComments(props.activity, props.path);
  return <DesignView {...props} comments={comments} />;
}
