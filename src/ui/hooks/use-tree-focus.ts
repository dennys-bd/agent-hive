import { useCallback, useEffect, useState } from 'react';
import type { Task } from '../../types';
import { OWNS_ESCAPE } from '@/components/DetailPanel';
import { focusSet } from '@/lib/tree-focus';

// An open dialog, menu or listbox closes itself on Escape: the key is its own, never the focus's
const OPEN_LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

const isLeaveKey = (event: KeyboardEvent): boolean =>
  event.key === 'Escape' && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

/** Esc leaves the focus (#35) while one is set and the flow shows. On the document's capture phase, ahead of the details panel's own Escape
 * (#426), which skips the key this prevents: one key, one thing, as the search field's (#542). The next Esc closes the panel. */
function useLeaveKey(isActive: boolean, leave: () => void): void {
  useEffect(() => {
    if (!isActive) return undefined;
    const listener = (event: KeyboardEvent): void => {
      if (!isLeaveKey(event)) return;
      if (event.target instanceof Element && event.target.closest(`${OWNS_ESCAPE}, ${OPEN_LAYER}`)) return;
      event.preventDefault();
      leave();
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [isActive, leave]);
}

/** The flow's focus on a subtree (#35): the focused itemId and the set it covers, set only together. Client state of the flow, never in
 * flowView: it is temporary. */
export interface TreeFocus { itemId?: string; focus?: ReadonlySet<string>; focusOn(itemId: string): void; leave(): void }

/** Flow's focus, kept out of Flow for its size, with its Esc while the flow shows. Leaving the flow unmounts Flow and the focus with it, and
 * so will a switch of flowchart, once Flow is keyed by one. */
export function useTreeFocus(tasks: readonly Task[], source: string | undefined, isShown: boolean): TreeFocus {
  const [focused, setFocused] = useState<string>();
  const [seenSource, setSeenSource] = useState(source);
  // A new source drops the focus. Adjusted while rendering rather than in an effect, so no frame shows the old source's focus
  if (seenSource !== source) {
    setSeenSource(source);
    setFocused(undefined);
  }
  const leave = useCallback(() => setFocused(undefined), []);
  // Derived, not stored: a focused task that left the list reads as no focus, and its trail goes away with it
  const focus = focused === undefined ? undefined : focusSet(tasks, focused);
  useLeaveKey(focus !== undefined && isShown, leave);
  return { itemId: focus === undefined ? undefined : focused, focus, focusOn: setFocused, leave };
}
