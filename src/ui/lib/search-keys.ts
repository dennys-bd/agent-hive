import { type RefObject, useEffect, useRef } from 'react';
import { onShortcutKey } from '@/lib/dock-layout';
import { pressed } from '@/lib/shortcut-bindings';
import { SHORTCUTS } from '../../shortcut-registry';
import type { OperationId } from '../../types';

/** The attribute the pane's keys gate on, as the files tree's keys gate on their tree (#818). */
export const SEARCH_PANE_ATTR = 'data-search-pane';

export type SearchKey = 'matchCase' | 'wholeWord' | 'regex' | 'replaceAll';

const SEARCH_KEYS: ReadonlyArray<[SearchKey, OperationId]> = [
  ['matchCase', 'searchMatchCase'], ['wholeWord', 'searchWholeWord'], ['regex', 'searchRegex'], ['replaceAll', 'searchReplaceAll'],
];

const isInPane = (target: EventTarget | null): boolean => target instanceof Element && target.closest(`[${SEARCH_PANE_ATTR}]`) !== null;

/** Whether shortcut `id` stands aside for the pane (#868): inside it, a key a search shortcut also holds acts as that one only (⌥⌘C is
 * openDiff's elsewhere). Only the activities and global keys yield; the pane's own keys never do. */
export function yieldsToSearchPane(id: OperationId, event: KeyboardEvent): boolean {
  if (!isInPane(event.target)) return false;
  const scope = SHORTCUTS.find((s) => s.id === id)?.scope;
  return (scope === 'activities' || scope === 'global') && SEARCH_KEYS.some(([, searchId]) => pressed(event, searchId));
}

/** Mounted with the pane, as useTreeKeys is (#818): its keys reach `onKey`, the latest, only with the focus inside `pane`. */
export function useSearchPaneKeys(pane: RefObject<HTMLElement | null>, onKey: (key: SearchKey) => void): void {
  const latest = useRef(onKey);
  useEffect(() => {
    latest.current = onKey;
  });
  useEffect(() => onShortcutKey(SEARCH_KEYS, (key) => latest.current(key), (event) => event.target instanceof Element && pane.current?.contains(event.target) === true), [pane]);
}
