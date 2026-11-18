import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

const NONE: readonly string[] = [];
// Anything but { uncovered: string[] } reads as none: the hint only ever names what the server named
const uncoveredOf = (read: unknown): readonly string[] => {
  const uncovered = typeof read === 'object' && read !== null ? (read as { uncovered?: unknown }).uncovered : undefined;
  return Array.isArray(uncovered) ? uncovered.filter((path): path is string => typeof path === 'string') : NONE;
};

/** GET /settings/copilot-trust once per mount (#880): the saved workspace folders Copilot does not trust yet. None while it loads or when the
 * read fails, as unknown and covered both show nothing; no watch, so the next open of Settings reads it again. */
export function useCopilotTrust(): readonly string[] {
  const [uncovered, setUncovered] = useState<readonly string[]>(NONE);
  useEffect(() => {
    let live = true;
    getJson<unknown>('/settings/copilot-trust').then(
      (read) => { if (live) setUncovered(uncoveredOf(read)); },
      () => { if (live) setUncovered(NONE); },
    );
    return () => { live = false; };
  }, []);
  return uncovered;
}
