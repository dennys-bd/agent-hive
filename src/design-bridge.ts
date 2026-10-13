// The design frame's bridge (#108): the one script the Hive puts into a design. It runs inside the sandboxed frame, whose origin is
// opaque, so it talks to the design pane by postMessage alone. The comment mode (#112) adds anchors, pins, the pointer capture and the forwarded keys.
import { type AnchorEntry, anchorFunctions, type ElementAnchor, type Pin, type Rect } from './design-anchor.js';

/** The anchor functions the bridge calls. They come in as an argument, not as imports: the frame's script has no modules, and a test
 *  transform rewrites an imported name inside a function body into a name the frame does not have. */
export interface AnchorHelpers {
  elementAnchor: (el: Element) => ElementAnchor;
  findAnchor: (doc: Document, anchor: ElementAnchor) => Element | null;
  pinRects: (doc: Document, anchors: readonly AnchorEntry[]) => Pin[];
  isEditable: (target: EventTarget | null) => boolean;
  isAnchorList: (value: unknown) => value is AnchorEntry[];
}

interface Point { x: number; y: number }

/** What the bridge's functions share. Mutable on purpose: it is the frame script's state between two events, and none of it outlives
 *  a load (the parent sends anchors again after every ready). */
interface BridgeState {
  helpers: AnchorHelpers;
  post: (message: Record<string, unknown>) => void;
  on: boolean;
  cursor: string;
  anchors: AnchorEntry[];
  pending: boolean;
  /** Where the pointer went down, in document coordinates; null between presses. */
  start: Point | null;
  dragged: boolean;
  outline: HTMLElement;
  area: HTMLElement;
}

/** Runs inside the frame, joined with its siblings by bridgeScript: it reads only its argument, browser globals and the functions
 *  joined beside it. Answers its teardown, which the tests call; the frame never does. */
export function designBridge(helpers: AnchorHelpers): () => void {
  const root = document.documentElement;
  const listening = new AbortController();
  const { signal } = listening;
  // '*': the frame cannot know which allowed host the parent was opened on, and the parent already serves the text anchors carry
  const post = (message: Record<string, unknown>): void => window.parent.postMessage({ hive: 'design', ...message }, '*');
  const bridge: BridgeState = {
    helpers, post, on: false, cursor: '', anchors: [], pending: false, start: null, dragged: false,
    outline: bridgeOverlay('outline'), area: bridgeOverlay('area'),
  };
  let height = -1;
  let width = -1;
  // the width lets the pane widen its frame for a window screen wider than the viewport (#241)
  const postSize = (): void => {
    if (root.scrollHeight === height && root.scrollWidth === width) return;
    height = root.scrollHeight;
    width = root.scrollWidth;
    post({ type: 'size', height, width });
  };
  // with no anchor there is no pin to move: a scroll then posts nothing
  const refreshPins = (): void => {
    if (bridge.anchors.length > 0) schedulePins(bridge);
  };
  const pointer = (event: MouseEvent): void => bridgePointer(bridge, event);
  window.addEventListener('message', (event: MessageEvent<unknown>) => bridgeMessage(bridge, event), { signal });
  // ready on every load: the parent reloads the frame on a version change and marks it reloaded at the ready that follows. The tweaks block
  // after it: the parent sends its values at ready, then settles them against the block that follows (#241)
  window.addEventListener('load', () => {
    post({ type: 'ready' });
    postTweaks(post);
    postSize();
  }, { signal });
  // capture: scroll does not bubble, and an inner scroller moves the pins as much as the page does
  window.addEventListener('scroll', refreshPins, { capture: true, signal });
  window.addEventListener('resize', refreshPins, { signal });
  // capture on window: while commenting, the design's own handlers and links must not fire
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'click'] as const) window.addEventListener(type, pointer, { capture: true, signal });
  window.addEventListener('keydown', (event: KeyboardEvent) => bridgeKey(bridge, event), { capture: true, signal });
  const observer = new ResizeObserver(() => {
    postSize();
    refreshPins();
  });
  observer.observe(root);
  return () => {
    listening.abort();
    observer.disconnect();
    setCommentMode(bridge, false);
  };
}

/** The hover outline or the drag rectangle (handoff, "Comentar"). The design's own elements are never styled: that would leak into
 *  its look. #3b82f6 is the dark theme's --review and 12px its radius-xl: the frame has no Hive tokens. */
function bridgeOverlay(kind: 'outline' | 'area'): HTMLElement {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-hive', kind);
  const look = kind === 'outline'
    ? 'outline:2px solid #3b82f6;outline-offset:6px'
    : 'border:1.5px dashed #3b82f6;background:rgb(59 130 246 / .06);border-radius:12px';
  overlay.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;${look}`;
  return overlay;
}

/** Shows the overlay over a frame-viewport rect, or hides it. */
function placeOverlay(overlay: HTMLElement, rect: Rect | null): void {
  overlay.style.display = rect ? 'block' : 'none';
  if (!rect) return;
  overlay.style.left = `${rect.x}px`;
  overlay.style.top = `${rect.y}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

function dragRect(from: Point, to: Point): Rect {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

function setCommentMode(bridge: BridgeState, on: boolean): void {
  if (bridge.on === on) return;
  const root = document.documentElement;
  bridge.on = on;
  bridge.start = null;
  bridge.dragged = false;
  if (on) {
    bridge.cursor = root.style.cursor;
    root.style.cursor = 'crosshair'; // the parent's crosshair does not reach inside the frame
    root.append(bridge.outline, bridge.area);
    return;
  }
  root.style.cursor = bridge.cursor;
  placeOverlay(bridge.outline, null);
  placeOverlay(bridge.area, null);
  bridge.outline.remove();
  bridge.area.remove();
}

/** One pins report per frame: a scroll fires many events, and the parent redraws its pins once per paint anyway. */
function schedulePins(bridge: BridgeState): void {
  if (bridge.pending) return;
  bridge.pending = true;
  requestAnimationFrame(() => {
    bridge.pending = false;
    bridge.post({ type: 'pins', pins: bridge.helpers.pinRects(document, bridge.anchors) });
  });
}

/** scrollIntoView for an element, since the frame is sized to its content and the scrollers that matter are inner ones; an area
 *  centres its rect in the window. A removed anchor scrolls nothing. */
function scrollToAnchor(bridge: BridgeState, id: string): void {
  const entry = bridge.anchors.find((candidate) => candidate.id === id);
  if (!entry) return;
  const { anchor } = entry;
  if (anchor.kind === 'area') {
    window.scrollTo({
      left: anchor.rect.x + anchor.rect.width / 2 - window.innerWidth / 2,
      top: anchor.rect.y + anchor.rect.height / 2 - window.innerHeight / 2,
    });
  } else {
    bridge.helpers.findAnchor(document, anchor)?.scrollIntoView({ block: 'center' });
  }
  schedulePins(bridge);
}

/** The design's hv-tweaks block, raw (#241): the pane parses and checks it, since the frame's content is untrusted. No block, no message. */
function postTweaks(post: (message: Record<string, unknown>) => void): void {
  const block = document.getElementById('hv-tweaks');
  if (block === null) return;
  let schema: unknown;
  try {
    schema = JSON.parse(block.textContent ?? '');
  } catch {
    post({ type: 'tweaks', schema: null, error: 'json' });
    return;
  }
  post({ type: 'tweaks', schema });
}

/** A tweak's value where the design reacts to it (#241): data-tweak-<name> on the root for CSS, hv:tweak for a script. The name pattern is
 *  design-tweaks.ts's TWEAK_NAME, inlined: the frame's script has no imports. The value is not checked against the schema: the pane sends
 *  only fitting ones. */
function applyTweak(name: unknown, value: unknown): void {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) return;
  if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) return;
  document.documentElement.setAttribute(`data-tweak-${name}`, String(value));
  window.dispatchEvent(new CustomEvent('hv:tweak', { detail: { name, value } }));
}

function bridgeMessage(bridge: BridgeState, event: MessageEvent<unknown>): void {
  const data = event.data;
  if (event.source !== window.parent || typeof data !== 'object' || data === null) return; // the design itself may post too
  const { hive, type, theme, on, anchors, id, name, value } = data as Record<string, unknown>;
  if (hive !== 'design') return;
  if (type === 'theme' && (theme === 'dark' || theme === 'light')) {
    document.documentElement.style.colorScheme = theme;
    document.documentElement.dataset.theme = theme;
  } else if (type === 'comment-mode' && typeof on === 'boolean') {
    setCommentMode(bridge, on);
  } else if (type === 'anchors' && bridge.helpers.isAnchorList(anchors)) {
    bridge.anchors = anchors;
    schedulePins(bridge);
  } else if (type === 'scroll-to' && typeof id === 'string') {
    scrollToAnchor(bridge, id);
  } else if (type === 'tweak') {
    applyTweak(name, value);
  }
}

/** The comment mode's pointer: a press may start a drag, a move outlines or draws, a release ends a drag, a click anchors an element. */
function bridgePointer(bridge: BridgeState, event: MouseEvent): void {
  if (!bridge.on) return;
  event.preventDefault();
  event.stopPropagation();
  const at = { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY };
  if (event.type === 'mousedown') {
    if (event.button !== 0) return; // only the main button draws an area
    bridge.start = at;
    bridge.dragged = false;
  } else if (event.type === 'mousemove') {
    pointerMove(bridge, event, at);
  } else if (event.type === 'mouseup') {
    pointerUp(bridge, at);
  } else if (bridge.dragged) {
    bridge.dragged = false; // the click a drag ends with anchors nothing
  } else if (event.target instanceof Element && !event.target.hasAttribute('data-hive')) {
    bridge.post({ type: 'anchor', anchor: bridge.helpers.elementAnchor(event.target) });
  }
}

/** A pressed pointer that has moved DRAG_THRESHOLD px or more draws the area; otherwise the element under it is outlined. */
function pointerMove(bridge: BridgeState, event: MouseEvent, at: Point): void {
  const DRAG_THRESHOLD = 4;
  const { start } = bridge;
  if (start && (bridge.dragged || Math.hypot(at.x - start.x, at.y - start.y) >= DRAG_THRESHOLD)) {
    bridge.dragged = true;
    const rect = dragRect(start, at);
    placeOverlay(bridge.outline, null);
    placeOverlay(bridge.area, { ...rect, x: rect.x - window.scrollX, y: rect.y - window.scrollY });
    return;
  }
  placeOverlay(bridge.outline, event.target instanceof Element ? event.target.getBoundingClientRect() : null);
}

function pointerUp(bridge: BridgeState, at: Point): void {
  const { start, dragged } = bridge;
  bridge.start = null;
  placeOverlay(bridge.area, null);
  if (start && dragged) bridge.post({ type: 'anchor', anchor: { kind: 'area', rect: dragRect(start, at) } });
}

/** After the first comment click the focus is in the frame and the parent's keys stop working: c and Escape go to the parent, except
 *  while typing in a design's field. */
function bridgeKey(bridge: BridgeState, event: KeyboardEvent): void {
  if (event.key !== 'c' && event.key !== 'Escape') return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (bridge.helpers.isEditable(event.target)) return;
  if (event.key === 'Escape' && bridge.on) event.preventDefault();
  bridge.post({ type: 'key', key: event.key });
}

// Joined beside the anchor functions, as siblings in the frame's one script
const BRIDGE_FUNCTIONS = [
  bridgeOverlay, placeOverlay, dragRect, setCommentMode, schedulePins, scrollToAnchor, bridgeMessage, bridgePointer, pointerMove,
  pointerUp, bridgeKey, postTweaks, applyTweak, designBridge,
];

/** The bridge as the inline script the design frame route puts into every HTML page it serves (#108): inline, so it needs no route.
 *  Function.toString carries no import, so every function the bridge reaches is joined in, and the anchor functions it calls are
 *  handed over by name. */
// The arrow wrapper keeps the joined functions out of the design's global scope: a design declaring one of their names would otherwise
// break its own script or replace ours
export const bridgeScript = (): string =>
  `<script>(() => {\n${[...anchorFunctions, ...BRIDGE_FUNCTIONS].map(String).join('\n')}\ndesignBridge({ elementAnchor, findAnchor, pinRects, isEditable, isAnchorList });\n})()</script>`;
