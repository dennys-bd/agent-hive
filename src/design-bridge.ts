// The design frame's bridge (#108): the one script the Hive puts into a design. It runs inside the sandboxed frame, whose origin is
// opaque, so it talks to the design pane by postMessage alone. The comment mode (#112) adds anchors, pins and scrolling to an anchor.
import { type AnchorEntry, anchorFunctions, type ElementAnchor, type Pin } from './design-anchor.js';

/** The anchor functions the bridge calls. They come in as an argument, not as imports: the frame's script has no modules, and a test
 *  transform rewrites an imported name inside a function body into a name the frame does not have. */
export interface AnchorHelpers {
  elementAnchor: (el: Element) => ElementAnchor;
  findAnchor: (doc: Document, anchor: ElementAnchor) => Element | null;
  pinRects: (doc: Document, anchors: readonly AnchorEntry[]) => Pin[];
  isEditable: (target: EventTarget | null) => boolean;
  isAnchorList: (value: unknown) => value is AnchorEntry[];
}

/** What the bridge's functions share. Mutable on purpose: it is the frame script's state between two events, and none of it outlives
 *  a load (the parent sends anchors again after every ready). */
interface BridgeState {
  helpers: AnchorHelpers;
  post: (message: Record<string, unknown>) => void;
  on: boolean;
  cursor: string;
  anchors: AnchorEntry[];
  pending: boolean;
}

/** Runs inside the frame, joined with its siblings by bridgeScript: it reads only its argument, browser globals and the functions
 *  joined beside it. Answers its teardown, which the tests call; the frame never does. */
export function designBridge(helpers: AnchorHelpers): () => void {
  const root = document.documentElement;
  const listening = new AbortController();
  const { signal } = listening;
  // '*': the frame cannot know which allowed host the parent was opened on, and the parent already serves the text anchors carry
  const post = (message: Record<string, unknown>): void => window.parent.postMessage({ hive: 'design', ...message }, '*');
  const bridge: BridgeState = { helpers, post, on: false, cursor: '', anchors: [], pending: false };
  let height = -1;
  const postSize = (): void => {
    if (root.scrollHeight === height) return;
    height = root.scrollHeight;
    post({ type: 'size', height });
  };
  // with no anchor there is no pin to move: a scroll then posts nothing
  const refreshPins = (): void => {
    if (bridge.anchors.length > 0) schedulePins(bridge);
  };
  window.addEventListener('message', (event: MessageEvent<unknown>) => bridgeMessage(bridge, event), { signal });
  // ready on every load: the parent reloads the frame on a version change and marks it reloaded at the ready that follows
  window.addEventListener('load', () => {
    post({ type: 'ready' });
    postSize();
  }, { signal });
  // capture: scroll does not bubble, and an inner scroller moves the pins as much as the page does
  window.addEventListener('scroll', refreshPins, { capture: true, signal });
  window.addEventListener('resize', refreshPins, { signal });
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

function setCommentMode(bridge: BridgeState, on: boolean): void {
  if (bridge.on === on) return;
  const root = document.documentElement;
  bridge.on = on;
  if (on) bridge.cursor = root.style.cursor;
  // the parent's crosshair does not reach inside the frame
  root.style.cursor = on ? 'crosshair' : bridge.cursor;
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

function bridgeMessage(bridge: BridgeState, event: MessageEvent<unknown>): void {
  const data = event.data;
  if (event.source !== window.parent || typeof data !== 'object' || data === null) return; // the design itself may post too
  const { hive, type, theme, on, anchors, id } = data as Record<string, unknown>;
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
  }
}

// Joined beside the anchor functions, as siblings in the frame's one script
const BRIDGE_FUNCTIONS = [setCommentMode, schedulePins, scrollToAnchor, bridgeMessage, designBridge];

/** The bridge as the inline script the design frame route puts into every HTML page it serves (#108): inline, so it needs no route.
 *  Function.toString carries no import, so every function the bridge reaches is joined in, and the anchor functions it calls are
 *  handed over by name. */
export const bridgeScript = (): string =>
  `<script>${[...anchorFunctions, ...BRIDGE_FUNCTIONS].map(String).join('\n')}\ndesignBridge({ elementAnchor, findAnchor, pinRects, isEditable, isAnchorList })</script>`;
