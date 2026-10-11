import { useEffect, useState } from 'react';
import type { BlockerRef } from '../../types';
import { findBlockerCandidates } from '@/lib/blockers-api';

const SEARCH_DELAY_MS = 250; // one search per pause in the typing, not one per key

/** What the add row lists under its field (#57). */
export interface BlockerSearch { candidates: BlockerRef[]; loading: boolean }
const IDLE: BlockerSearch = { candidates: [], loading: false };

/** The add row's search (#57): the trimmed text, 250ms after its last change, to the item's candidates route; nothing for an empty text. A
 * newer text aborts the older request and its answer is dropped, so a stale list never replaces a fresh one. A failed search lists nothing:
 * the typed ref stays offered and the add itself reports its own refusal. */
export function useBlockerSearch(source: string, itemId: string, text: string): BlockerSearch {
  const [search, setSearch] = useState<BlockerSearch>(IDLE);
  const query = text.trim();
  useEffect(() => {
    if (query === '') {
      setSearch(IDLE);
      return undefined;
    }
    const controller = new AbortController();
    const isStale = (): boolean => controller.signal.aborted;
    setSearch((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      findBlockerCandidates(source, itemId, query, controller.signal).then(
        (candidates) => { if (!isStale()) setSearch({ candidates, loading: false }); },
        () => { if (!isStale()) setSearch(IDLE); },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, itemId, query]);
  return search;
}
