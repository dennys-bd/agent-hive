import { type PointerEvent as ReactPointerEvent, useState } from 'react';
import type { RunTab } from '@/components/terminal-tabs';

/** A tab on its way to a window of its own (#252), only from the entry's menu (#440). */
export type Detach = (tab: RunTab) => void;

/** One session-list row for the drag math (#359): its tab's key and its own live getBoundingClientRect. */
export interface DragRow { key: string; rect: DOMRect }

/** Where a dragged entry would land: before that tab's key, or the list's end. */
export type TabTarget = string | 'end';

/** The flow task's half-box rule (#122) over the whole list (#440): the first row whose own midpoint along `axis` is past the pointer, the
 * dragged row included, so every gap between entries is reachable; the end past every midpoint. The session list reads it down (y), a
 * center tab strip across (x, #458). */
export function dropTarget(rows: readonly DragRow[], at: number, axis: 'x' | 'y' = 'y'): TabTarget {
  const middle = (rect: DOMRect): number => (axis === 'y' ? (rect.top + rect.bottom) / 2 : (rect.left + rect.right) / 2);
  return rows.find((row) => at < middle(row.rect))?.key ?? 'end';
}

/** A target that already matches where the dragged entry sits (before itself, before the entry right after it, or the end when it is
 * already last) moves nothing: no line, and a release does nothing. The task drag's "dropped on itself" rule (#122). */
export function isNoOpTarget(target: TabTarget, draggedKey: string, keys: readonly string[]): boolean {
  if (target === draggedKey) return true;
  const index = keys.indexOf(draggedKey);
  if (index === -1) return false; // the dragged tab left mid-drag (its run ended): nothing to compare against
  if (target === 'end') return index === keys.length - 1;
  return keys[index + 1] === target;
}

/** The index moveTab (terminal-tabs.ts) expects for `target`: its place in the list without the dragged key, or that list's length. */
export function toIndex(target: TabTarget, draggedKey: string, keys: readonly string[]): number {
  const others = keys.filter((key) => key !== draggedKey);
  return target === 'end' ? others.length : others.indexOf(target);
}

// Every `<li>` in the entry's own <ul> (#359), keyed by data-tab-key (TabList sets it), read fresh on each move: the list stays still while
// an entry drags (#440), so the DOM order is the tabs' order that moveTab and toIndex count in.
function rowsOf(list: Element): DragRow[] {
  return Array.from(list.children).flatMap((li) => {
    const key = li instanceof HTMLElement ? li.dataset.tabKey : undefined;
    return key === undefined ? [] : [{ key, rect: li.getBoundingClientRect() }];
  });
}

const PRIMARY_BUTTON = 0;

interface PointerAt { clientX: number; clientY: number }

const inside = (rect: DOMRect, { clientX, clientY }: PointerAt): boolean =>
  clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;

// Where letting go at `at` would land `key` in `list`, or none: the pointer outside the list, where a release means nothing (#440), or a
// target that moves nothing
function targetIn(list: Element, key: string, at: PointerAt): TabTarget | undefined {
  if (!inside(list.getBoundingClientRect(), at)) return undefined;
  const rows = rowsOf(list);
  const target = dropTarget(rows, at.clientY);
  return isNoOpTarget(target, key, rows.map((row) => row.key)) ? undefined : target;
}

type ButtonPointer = ReactPointerEvent<HTMLButtonElement>;
interface TabDragHandlers {
  onPointerDown(event: ButtonPointer): void; onPointerMove(event: ButtonPointer): void; onPointerUp(event: ButtonPointer): void;
  onPointerCancel(): void; onLostPointerCapture(): void;
}

/** The session list's drag (#359, #440): what is dragged and the line's target, shown by TabList, plus one entry's handlers. */
export interface TabDrag { dragged?: string; target?: TabTarget; handlers(key: string): TabDragHandlers }

// The entry's own <ul>, while this pointer is captured by it: pointer capture makes the whole drag one entry's events
const capturedList = (event: ButtonPointer): Element | null =>
  (event.currentTarget.hasPointerCapture(event.pointerId) ? event.currentTarget.closest('ul') : null);

/** A session-list entry's drag (#440). The list never moves while it drags: the state is only the dragged key and the line's target, each set
 * when it changes. The primary button alone starts it, so the right-click menu and the middle-click close keep their events. The release
 * recomputes the target from its own event rather than trusting the state, so the move matches the pointer, and calls onMove once when
 * it lands inside the list on a real move. Anywhere else, a pointercancel or a lost capture: nothing moves and nothing detaches. */
export function useTabDrag(onMove: (key: string, toIndex: number) => void): TabDrag {
  const [dragged, setDragged] = useState<string>();
  const [target, setTarget] = useState<TabTarget>();
  const clear = (): void => {
    setDragged(undefined);
    setTarget(undefined);
  };
  const handlers = (key: string): TabDragHandlers => ({
    onPointerDown: (event) => {
      if (event.button !== PRIMARY_BUTTON) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragged(key);
    },
    onPointerMove: (event) => {
      const list = capturedList(event);
      if (!list) return;
      const next = targetIn(list, key, event);
      if (next !== target) setTarget(next);
    },
    onPointerUp: (event) => {
      const list = capturedList(event);
      clear();
      const landing = list ? targetIn(list, key, event) : undefined;
      if (list && landing !== undefined) onMove(key, toIndex(landing, key, rowsOf(list).map((row) => row.key)));
    },
    onPointerCancel: clear,
    onLostPointerCapture: clear,
  });
  return { dragged, target, handlers };
}
