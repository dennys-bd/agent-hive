import { type PointerEvent as ReactPointerEvent, useState } from 'react';
import { type DragRow, dropTarget, isNoOpTarget, type TabTarget, toIndex } from '@/components/tab-drag';
import { type CenterLayout, type Edge, groupsOf, moveRef, refKey, splitWith } from '@/lib/center-layout';

/** One group as the drag measures it (#458): its tab strip, its body and its tabs, each with its live getBoundingClientRect. */
export interface DropGroup { id: string; strip: DOMRect; body: DOMRect; tabs: DragRow[] }
/** Where a dragged center tab lands: before a tab (or the end) of a strip, on an edge of a group's body (a split), or its middle (a move). */
export type Landing =
  | { kind: 'strip'; group: string; target: TabTarget }
  | { kind: 'edge'; group: string; edge: Edge; share?: number } // share: the new group's percent; a drag leaves it out (50), the split menu 44 (#536)
  | { kind: 'middle'; group: string };
/** The dragged tab: its key and the group it sits in. */
export interface Dragged { key: string; group: string }

const EDGE_SHARE = 0.25; // a quarter of the body on each side is that side's edge
const PRIMARY_BUTTON = 0;

const inside = (rect: DOMRect, x: number, y: number): boolean => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

// The body's nearest edge while the pointer is within its quarter, else its middle
function bodyLanding(group: DropGroup, x: number, y: number): Landing {
  const fx = (x - group.body.left) / group.body.width;
  const fy = (y - group.body.top) / group.body.height;
  const distances: [Edge, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
  const [edge, distance] = distances.reduce((near, next) => (next[1] < near[1] ? next : near));
  return distance < EDGE_SHARE ? { kind: 'edge', group: group.id, edge } : { kind: 'middle', group: group.id };
}

// tab-drag's no-op rule (#440) for the center: its own place in its own strip, its own group's middle, or an edge of the group it is alone in
function isNoOp(landing: Landing, dragged: Dragged, groups: readonly DropGroup[]): boolean {
  if (landing.group !== dragged.group) return false;
  const keys = groups.find((group) => group.id === dragged.group)?.tabs.map((tab) => tab.key) ?? [];
  if (landing.kind === 'strip') return isNoOpTarget(landing.target, dragged.key, keys);
  return landing.kind === 'middle' || keys.length === 1;
}

/** Where letting go at (x, y) lands the dragged tab (#458), or none: outside every group, or a landing that moves nothing. */
export function landingOf(groups: readonly DropGroup[], x: number, y: number, dragged: Dragged): Landing | undefined {
  const hit = groups.find((group) => inside(group.strip, x, y) || inside(group.body, x, y));
  if (hit === undefined) return undefined;
  const landing: Landing = inside(hit.strip, x, y) ? { kind: 'strip', group: hit.id, target: dropTarget(hit.tabs, x, 'x') } : bodyLanding(hit, x, y);
  return isNoOp(landing, dragged, groups) ? undefined : landing;
}

/** The layout once `key` lands (#458): an edge splits that group with the tab on that side; a strip or a middle moves it there, the middle
 * to the group's end. The tab menu's split and move land the same way. */
export function applyLanding(layout: CenterLayout, key: string, landing: Landing): CenterLayout {
  if (landing.kind === 'edge') return splitWith(layout, key, landing.group, landing.edge, landing.share);
  const target = groupsOf(layout.root).find((group) => group.id === landing.group);
  if (target === undefined) return layout;
  const keys = target.tabs.map(refKey);
  const index = landing.kind === 'strip' ? toIndex(landing.target, key, keys) : keys.filter((other) => other !== key).length;
  return moveRef(layout, key, landing.group, index);
}

// Every group under the center's root, measured now: the tree may have changed since the drag began
function measure(root: Element): DropGroup[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-center-group]')).flatMap((element) => {
    const id = element.dataset.centerGroup;
    const strip = element.querySelector('[data-center-strip]');
    const body = element.querySelector('[data-center-body]');
    if (id === undefined || strip === null || body === null) return [];
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-key]')).flatMap((tab) => {
      const key = tab.dataset.tabKey;
      return key === undefined ? [] : [{ key, rect: tab.getBoundingClientRect() }];
    });
    return [{ id, strip: strip.getBoundingClientRect(), body: body.getBoundingClientRect(), tabs }];
  });
}

type ButtonPointer = ReactPointerEvent<HTMLButtonElement>;
interface CenterDragHandlers {
  onPointerDown(event: ButtonPointer): void; onPointerMove(event: ButtonPointer): void; onPointerUp(event: ButtonPointer): void;
  onPointerCancel(): void; onLostPointerCapture(): void;
}

/** The center's tab drag (#458): what is dragged and where it would land, drawn by the groups, plus one tab's handlers. */
export interface CenterDrag { dragged?: string; landing?: Landing; handlers(key: string, group: string): CenterDragHandlers }

// Where this pointer would land the tab while the tab holds its capture, measured from the center's root; none otherwise
function landingAt(event: ButtonPointer, dragged: Dragged): Landing | undefined {
  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return undefined;
  const root = event.currentTarget.closest('[data-center-root]');
  return root === null ? undefined : landingOf(measure(root), event.clientX, event.clientY, dragged);
}

const sameLanding = (a?: Landing, b?: Landing): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A center tab's drag (#458), useTabDrag's (#440) across groups: the primary button starts it, so the right-click menu keeps its events;
 * the tabs never move while it drags; the release recomputes its landing from its own event and calls onDrop once on a real move.
 * Anywhere else, a pointercancel or a lost capture: nothing moves. */
export function useCenterDrag(onDrop: (key: string, landing: Landing) => void): CenterDrag {
  const [dragged, setDragged] = useState<string>();
  const [landing, setLanding] = useState<Landing>();
  const clear = (): void => {
    setDragged(undefined);
    setLanding(undefined);
  };
  const handlers = (key: string, group: string): CenterDragHandlers => ({
    onPointerDown: (event) => {
      if (event.button !== PRIMARY_BUTTON) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragged(key);
    },
    onPointerMove: (event) => {
      const next = landingAt(event, { key, group });
      if (!sameLanding(next, landing)) setLanding(next);
    },
    onPointerUp: (event) => {
      const next = landingAt(event, { key, group });
      clear();
      if (next !== undefined) onDrop(key, next);
    },
    onPointerCancel: clear,
    onLostPointerCapture: clear,
  });
  return { dragged, landing, handlers };
}
