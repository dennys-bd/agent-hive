import { createContext, type RefCallback, type RefObject, useCallback, useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import { onShortcutKey } from '@/lib/dock-layout';

/** A screen to go back to (#911): its name on the back button, how to show it again, and its center's scroll when it was left. */
export interface BackEntry { label: string; restore(): void; scroll?: number }

/** The Dashboard's back stack (#911), for the window's life: no persistence and no forward. */
export interface BackStack {
  top?: BackEntry; // the previous screen: the button's label
  push(entry: BackEntry): void; // a navigation from inside the pages
  reset(entry?: BackEntry): void; // a pick from outside; with an entry, the stack holds only it
  back(): void; // pops one entry and restores it
  pending: RefObject<number | undefined>; // the scroll a back left for the restored screen's container (NavScrollContext)
}

/** The stack (#911). Each change makes a new array. `back` keeps the popped entry's scroll pending for the next marked container; a push or a
 * reset drops one not applied yet, since it belonged to the screen being left. */
export function useBackStack(): BackStack {
  const [entries, setEntries] = useState<readonly BackEntry[]>([]);
  const pending = useRef<number | undefined>(undefined);
  const top = entries.at(-1);
  return {
    top, pending,
    push: (entry) => {
      pending.current = undefined;
      setEntries((all) => [...all, entry]);
    },
    reset: (entry) => {
      pending.current = undefined;
      setEntries(entry === undefined ? [] : [entry]);
    },
    back: () => {
      if (top === undefined) return;
      setEntries(entries.slice(0, -1));
      pending.current = top.scroll;
      top.restore();
    },
  };
}

const MOUSE_BACK = 3; // the mouse's back side button: Electron on macOS reports it as button 3

/** ⌘[ (goBack, #585) and the mouse's back button call `onBack` while it is given: while the back button shows (#911). Both on window, as every
 * shortcut is; the mouse's default is prevented. The listeners read the latest render's onBack. */
export function useBackKeys(onBack: (() => void) | undefined): void {
  const isOn = onBack !== undefined;
  const act = useEffectEvent((): void => onBack?.());
  useEffect(() => {
    if (!isOn) return undefined;
    const offKey = onShortcutKey([[true, 'goBack']], () => act());
    const onMouse = (event: MouseEvent): void => {
      if (event.button !== MOUSE_BACK) return;
      event.preventDefault();
      act();
    };
    window.addEventListener('mouseup', onMouse);
    return () => {
      offKey();
      window.removeEventListener('mouseup', onMouse);
    };
  }, [isOn]);
}

// The scroll a back left for the restored screen (#911): the Dashboard provides its stack's. Outside one (a page rendered alone) none ever is,
// and the default is never written, since only a defined scroll is applied and cleared
export const NavScrollContext = createContext<RefObject<number | undefined>>({ current: undefined });

/** The center's scroll when a screen is left (#911): its marked container's, in the Dashboard's main. None on the flow, which keeps its pan in
 * flowView. */
export const navScrollTop = (): number | undefined => document.querySelector<HTMLElement>('main [data-nav-scroll]')?.scrollTop;

/** The ref of a center's scroll container (#911). It marks the container data-nav-scroll, where a push reads the scroll, and applies a pending
 * scroll once the content is tall enough: at once for a list from its module cache, or when a page's body arrives. The ResizeObserver on its
 * content is dropped once the scroll is applied. Applying clears it, so it happens at most once. Stable, so React attaches it once. */
export function useNavScroll(): RefCallback<HTMLElement> {
  const pending = useContext(NavScrollContext);
  return useCallback((el: HTMLElement | null) => {
    if (el === null) return undefined;
    el.dataset.navScroll = '';
    const apply = (): boolean => {
      const top = pending.current;
      if (top === undefined) return true;
      if (el.scrollHeight - el.clientHeight < top) return false;
      el.scrollTop = top;
      pending.current = undefined;
      return true;
    };
    if (apply()) return undefined;
    const observer = new ResizeObserver(() => {
      if (apply()) observer.disconnect();
    });
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [pending]);
}
