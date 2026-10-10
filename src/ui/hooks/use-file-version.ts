import { useEffect, useRef } from 'react';
import { fileUrl } from '@/lib/editor-models';

// ponytail: a poll stands in for a watch, as the files sidebar's tree does (use-task-tree.ts); a push from the daemon when the lag matters
export const VERSION_POLL_MS = 2000;

/** What a poll found (#717): the file's version on the disk, or null once the file is gone. */
export type DiskVersion = string | null;

/** Asks the file's version every VERSION_POLL_MS while the pane is shown, and once on each window focus (#717). Hands every answer to the
 * latest `onVersion`; a failed read (the daemon away, a 413 or a 415) is dropped, the last answer standing. */
export function useFileVersion(activityId: string, path: string, isShown: boolean, onVersion: (version: DiskVersion) => void): void {
  const latest = useRef(onVersion);
  useEffect(() => {
    latest.current = onVersion;
  });
  useEffect(() => {
    if (!isShown) return undefined;
    let live = true;
    let isAsking = false; // a slow daemon must not stack requests
    const read = (): void => {
      if (isAsking) return;
      isAsking = true;
      fetch(fileUrl(activityId, path, 'file-version')).then(async (res) => {
        if (res.status === 404) return null;
        return res.ok ? ((await res.json()) as { version: string }).version : undefined;
      }).then((version) => {
        if (live && version !== undefined) latest.current(version);
      }, () => undefined).finally(() => { isAsking = false; });
    };
    const timer = setInterval(read, VERSION_POLL_MS);
    window.addEventListener('focus', read);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [activityId, path, isShown]);
}
