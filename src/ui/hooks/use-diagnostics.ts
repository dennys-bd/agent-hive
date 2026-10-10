import { useSyncExternalStore } from 'react';
import { type Counts, fileCounts, snapshot, subscribe } from '@/lib/diagnostics-store';

/** Re-renders on every change of the language servers' states and diagnostics (#780); read the store's getters after it. */
export const useDiagnostics = (): number => useSyncExternalStore(subscribe, snapshot);

/** A file name's diagnostic tone (#780): destructive with an error, waiting with warnings only; infos never colour. */
export function toneOf(counts: Counts): string | undefined {
  if (counts.errors > 0) return 'text-destructive';
  return counts.warnings > 0 ? 'text-waiting' : undefined;
}

/** The tone of a file's tab (#780); none while its server is not ready, or for a tab that is no file. */
export function useFileTone(activityId: string, path: string | undefined): string | undefined {
  useDiagnostics();
  return path === undefined ? undefined : toneOf(fileCounts(activityId, path));
}
