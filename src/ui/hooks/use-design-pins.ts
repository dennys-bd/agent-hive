import { type RefObject, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { type AnchorEntry, isAnchorList, type Pin, type Rect } from '../../design-anchor.js';
import type { DesignTarget } from '../../types.js';
import type { DesignCommentsModel } from '@/hooks/use-design-comments';
import { type DesignState, isOnState } from '@/lib/design-comments';

// The design pane's comment canvas (#114): the bridge's side of the comment mode (#112), and the state the pane's keys and the bridge's
// key message share, so both paths reach one owner.

/** The bridge's answer per comment id: null, its target is gone; missing, not answered since the frame's last load. */
export type PinRects = ReadonlyMap<string, Rect | null>;
export type CommentTab = 'open' | 'resolved';
/** isFromPin: a pin's click chose it, so the panel scrolls its item into view; an item's own click is in view already. */
export interface CommentSelection { id: string; isFromPin: boolean }

/** A message from this pane's frame in the protocol's envelope (#108), else undefined: the design itself may post too. */
export function bridgeData(event: MessageEvent<unknown>, frame: HTMLIFrameElement | null): Record<string, unknown> | undefined {
  const { data } = event;
  if (event.source === null || event.source !== frame?.contentWindow || typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  return record.hive === 'design' ? record : undefined;
}

// '*': the sandboxed frame's origin is opaque, so no named origin matches it (#108)
const post = (frame: HTMLIFrameElement | null, message: Record<string, unknown>): void => {
  frame?.contentWindow?.postMessage({ hive: 'design', ...message }, '*');
};

// The frame's own shape check (design-anchor.ts), so the pane takes no anchor the bridge itself would refuse
const isTarget = (value: unknown): value is DesignTarget => isAnchorList([{ id: '', anchor: value }]);
// A pin's rect is null for a removed target, else as finite as an area's
const isPinList = (value: unknown): value is Pin[] => Array.isArray(value) && value.every((entry: unknown) => {
  const { id, rect } = (entry ?? {}) as Record<string, unknown>;
  return typeof id === 'string' && (rect === null || isTarget({ kind: 'area', rect }));
});

/** The file's comments made on the pane's state, open and resolved, as the bridge's anchors (#114, #241): a pin never points at an element
 *  that moved or is gone in another state. Each gets a rect, so its panel item knows whether its target is gone; what is drawn is filtered after. */
export const anchorsOf = (model: DesignCommentsModel | undefined, state: DesignState): AnchorEntry[] =>
  (model === undefined ? [] : [...model.open, ...model.resolved].filter((c) => isOnState(c.anchor, state)).map((c) => ({ id: c.id, anchor: c.anchor })));

export interface FrameEvents { onAnchor(target: DesignTarget): void; onKey(key: string): void }
/** reload: the frame's ready (#112), as the bridge keeps nothing across a load. scrollTo: an item's click. */
export interface PinsBridge { rects: PinRects; reload(): void; scrollTo(id: string): void }

const pinElement = (canvas: HTMLElement | null, id: string): HTMLElement | undefined =>
  Array.from(canvas?.querySelectorAll<HTMLElement>('[data-pin]') ?? []).find((el) => el.dataset.pin === id);

/** The bridge side of a design pane's comments (#114): posts the anchors and the mode on each change and on reload, reads pins, anchors and
 *  keys from this pane's frame only. */
export function useDesignPins(frame: RefObject<HTMLIFrameElement | null>, canvas: RefObject<HTMLElement | null>, anchors: readonly AnchorEntry[], isCommenting: boolean, events: FrameEvents): PinsBridge {
  const [rects, setRects] = useState<PinRects>(() => new Map());
  const scrolling = useRef<string | undefined>(undefined);
  const [scrollRequest, setScrollRequest] = useState<{ id: string }>();
  const onAnchor = useEffectEvent(events.onAnchor);
  const onKey = useEffectEvent(events.onKey);
  const list = JSON.stringify(anchors); // a new array on every render: its text says whether the list changed
  useEffect(() => post(frame.current, { type: 'anchors', anchors: JSON.parse(list) as unknown }), [frame, list]);
  useEffect(() => post(frame.current, { type: 'comment-mode', on: isCommenting }), [frame, isCommenting]);
  // After the anchors effect above: a comment that switched the pane's state reaches the bridge's anchors before its scroll-to (#241). A new
  // object per click, so the same item scrolls again
  useEffect(() => {
    if (scrollRequest === undefined) return;
    scrolling.current = scrollRequest.id;
    post(frame.current, { type: 'scroll-to', id: scrollRequest.id });
  }, [frame, scrollRequest]);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = bridgeData(event, frame.current);
      if (data?.type === 'pins' && isPinList(data.pins)) setRects(new Map(data.pins.map((pin) => [pin.id, pin.rect])));
      else if (data?.type === 'anchor' && isTarget(data.anchor)) onAnchor(data.anchor);
      else if (data?.type === 'key' && typeof data.key === 'string') onKey(data.key);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
  // After an item's scroll-to, the bridge scrolls the design's inner scrollers and answers pins; then the canvas centres that pin
  useEffect(() => {
    const id = scrolling.current;
    if (id === undefined) return;
    scrolling.current = undefined; // the bridge answers every scroll-to with pins (#112): disarmed there, so a later scroll never yanks the canvas
    if (rects.has(id)) pinElement(canvas.current, id)?.scrollIntoView({ block: 'center' }); // a null rect drew no pin: nothing scrolls
  }, [canvas, rects]);
  const reload = (): void => {
    setRects(new Map()); // until the new load answers, no pin is drawn and no item reads removed
    post(frame.current, { type: 'anchors', anchors });
    post(frame.current, { type: 'comment-mode', on: isCommenting });
  };
  return { rects, reload, scrollTo: (id) => setScrollRequest({ id }) };
}

// The comments panel's open state (#241): one for every design pane, closed when the Hive opens, then the last choice wherever it came
// from (the bar's button, the panel's ×, a pin). In memory only, as the session in focus (lib/session-focus.ts)
let isPanelOpen = false;
const panelListeners = new Set<() => void>();
const subscribePanel = (listener: () => void): (() => void) => {
  panelListeners.add(listener);
  return () => { panelListeners.delete(listener); };
};

/** Shows or hides the comments panel of every design pane (#241). */
export function showCommentsPanel(shown: boolean): void {
  if (isPanelOpen === shown) return;
  isPanelOpen = shown;
  for (const listener of panelListeners) listener();
}

/** What a design pane's comments show and do (#114). takeKey: c and Escape, from the pane's keydown or the bridge's key message; true: taken. */
export interface CommentCanvas {
  isCommenting: boolean; target?: DesignTarget; selection?: CommentSelection; tab: CommentTab; isPanelShown: boolean;
  toggle(): void; takeKey(key: string): boolean; aim(target: DesignTarget): void; close(): void; closeIf(aimed: DesignTarget): void;
  setTab(next: CommentTab): void; setPanelShown(shown: boolean): void; selectItem(id: string): void; selectPin(id: string): void;
}

/** The pane's comment state (#114): one owner for the bar, the panel, the pins, the composer and both key paths. A local activity (no
 *  model) never enters comment mode: it has no review (#113). */
export function useCommentCanvas(model: DesignCommentsModel | undefined): CommentCanvas {
  const [isCommenting, setCommenting] = useState(false);
  const [target, setTarget] = useState<DesignTarget>();
  const [selection, setSelection] = useState<CommentSelection>();
  const [tab, setTab] = useState<CommentTab>('open');
  const isPanelShown = useSyncExternalStore(subscribePanel, () => isPanelOpen);
  // Either way drops the composer. A saved comment leaves the mode on: several in a row is the common case
  const toggle = (): void => {
    setCommenting((on) => !on);
    setTarget(undefined);
  };
  // Esc closes the composer first, then the mode
  const takeKey = (key: string): boolean => {
    if (key.toLowerCase() === 'c' && model !== undefined) toggle(); // Caps Lock's C too; the pane's keydown already refuses shift
    else if (key === 'Escape' && target !== undefined) setTarget(undefined);
    else if (key === 'Escape' && isCommenting) setCommenting(false);
    else return false;
    return true;
  };
  // A pin shows its item: the panel shown, on the tab that lists it
  const selectPin = (id: string): void => {
    setTab(model?.resolved.some((c) => c.id === id) ? 'resolved' : 'open');
    showCommentsPanel(true);
    setSelection({ id, isFromPin: true });
  };
  return {
    isCommenting, target, selection, tab, isPanelShown, toggle, takeKey, selectPin, setTab, setPanelShown: showCommentsPanel,
    aim: (next) => { if (isCommenting) setTarget(next); }, // a new anchor re-aims an open composer, its text kept
    close: () => setTarget(undefined),
    closeIf: (aimed) => setTarget((now) => (now === aimed ? undefined : now)), // a slow save must not close a composer re-aimed meanwhile
    selectItem: (id) => setSelection({ id, isFromPin: false }),
  };
}
