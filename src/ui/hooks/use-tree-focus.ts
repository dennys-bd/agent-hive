import { useCallback, useState } from 'react';
import type { Task } from '../../types';
import { focusSet } from '@/lib/tree-focus';

/** The flow's focus on a subtree (#35): the focused itemId and the set it covers, set only together. Client state of the flow, never in
 * flowView: it is temporary. */
export interface TreeFocus { itemId?: string; focus?: ReadonlySet<string>; focusOn(itemId: string): void; leave(): void }

/** Flow's focus, kept out of Flow for its size. Leaving the flow unmounts Flow and the focus with it, and so will a switch of flowchart, once
 * Flow is keyed by one. */
export function useTreeFocus(tasks: readonly Task[], source: string | undefined): TreeFocus {
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
  return { itemId: focus === undefined ? undefined : focused, focus, focusOn: setFocused, leave };
}
