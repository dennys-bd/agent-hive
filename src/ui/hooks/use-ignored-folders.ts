import { useEffect, useState } from 'react';
import type { FolderEntries } from '../../types';
import { getJson } from '../lib/api.js';
import { ignoredToRead } from '../lib/file-tree.js';
import { onTreeChanged } from '../lib/tree-place.js';
import { POLL_MS } from './use-task-tree.js';

const NONE: ReadonlyMap<string, FolderEntries> = new Map();
const folderUrl = (activityId: string, path: string): string => `/activities/${encodeURIComponent(activityId)}/tree/folder?path=${encodeURIComponent(path)}`;

/** The children on disk of every expanded ignored folder, and of every expanded folder under one (HIVE-22), by path. Read when shown, again
 *  every POLL_MS and after each tree operation (onTreeChanged), as useTaskTree reads the tree; a collapsed ignored folder is never read. A
 *  folder whose read fails (moved, deleted) leaves the map with no toast: the tree still shows it, unloaded. */
export function useIgnoredFolders(activityId: string, isShown: boolean, expanded: ReadonlySet<string>, ignoredFolders: readonly string[] | undefined): ReadonlyMap<string, FolderEntries> {
  const [loaded, setLoaded] = useState(NONE);
  // A key, not the set: each toggle and each poll make new objects, and only a change in what to read must restart the reads
  const key = ignoredToRead(expanded, ignoredFolders ?? []).join('\0');
  useEffect(() => {
    const paths = key === '' ? [] : key.split('\0');
    if (!isShown || paths.length === 0) {
      setLoaded(NONE);
      return undefined;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let isReading = false;
    let isAgain = false; // a change while a round flew: the next round goes as soon as that one settles
    const read = (): void => {
      if (isReading) {
        isAgain = true;
        return;
      }
      isReading = true;
      void Promise.allSettled(paths.map((path) => getJson<FolderEntries>(folderUrl(activityId, path)))).then((results) => {
        isReading = false;
        if (!live) return;
        setLoaded(new Map(results.flatMap((result, i) => (result.status === 'fulfilled' ? [[paths[i], result.value] as const] : []))));
        if (isAgain) {
          isAgain = false;
          read();
        } else timer = setTimeout(read, POLL_MS);
      });
    };
    read();
    const stop = onTreeChanged(activityId, () => { clearTimeout(timer); read(); });
    return () => { live = false; clearTimeout(timer); stop(); };
  }, [activityId, isShown, key]);
  return loaded;
}
