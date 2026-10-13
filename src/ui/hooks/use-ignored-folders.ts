import { useEffect, useState } from 'react';
import type { FolderEntries, GitMark } from '../../types';
import { getJson } from '../lib/api.js';
import { ignoredToRead } from '../lib/file-tree.js';
import { onTreeChanged } from '../lib/tree-place.js';
import { rememberMarks } from '../lib/tree-status.js';
import { POLL_MS } from './use-task-tree.js';

const NONE: ReadonlyMap<string, FolderEntries> = new Map();
const NO_MARKS: Readonly<Record<string, GitMark>> = {};

/** What useIgnoredFolders reads: the open folders' children, and every nested repository mark read so far by full path (#289). */
export interface LoadedFolders { loaded: ReadonlyMap<string, FolderEntries>; marks: Readonly<Record<string, GitMark>> }

// The marks belong to one activity: another one's must never colour this tree, even for the render before its first read
interface Remembered { activityId: string; marks: Readonly<Record<string, GitMark>> }
const folderUrl = (activityId: string, path: string): string => `/activities/${encodeURIComponent(activityId)}/tree/folder?path=${encodeURIComponent(path)}`;

/** The children on disk of every expanded ignored folder, and of every expanded folder under one (HIVE-22), by path. Read when shown, again
 *  every POLL_MS and after each tree operation (onTreeChanged), as useTaskTree reads the tree; a collapsed ignored folder is never read. A
 *  folder whose read fails (moved, deleted) leaves the map with no toast: the tree still shows it, unloaded. A collapsed folder's marks stay
 *  as last read (#289), with no re-read, so they keep raising the folders above it; they reset with the activity, and those under a folder
 *  no longer ignored (deleted, renamed) are left out. */
export function useIgnoredFolders(activityId: string, isShown: boolean, expanded: ReadonlySet<string>, ignoredFolders: readonly string[] | undefined): LoadedFolders {
  const [loaded, setLoaded] = useState(NONE);
  const [remembered, setRemembered] = useState<Remembered>({ activityId, marks: NO_MARKS });
  // Reset during render, not in an effect, so a switch back to the previous activity can never show its old marks
  if (remembered.activityId !== activityId) setRemembered({ activityId, marks: NO_MARKS });
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
        // A failed read keeps what the folder last showed: one transient error must not collapse an open subtree; a deleted folder leaves
        // the tree anyway, with its parent's next read
        setLoaded((prev) => new Map(results.flatMap((result, i) => {
          const entries = result.status === 'fulfilled' ? result.value : prev.get(paths[i]);
          return entries ? [[paths[i], entries] as const] : [];
        })));
        const fresh = new Map(results.flatMap((result, i) => (result.status === 'fulfilled' ? [[paths[i], result.value] as const] : [])));
        setRemembered((prev) => ({ activityId, marks: rememberMarks(prev.activityId === activityId ? prev.marks : NO_MARKS, fresh) }));
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
  const roots = ignoredFolders ?? [];
  const isUnderRoot = (path: string): boolean => roots.some((root) => path.startsWith(`${root}/`));
  const marks = remembered.activityId === activityId ? Object.fromEntries(Object.entries(remembered.marks).filter(([path]) => isUnderRoot(path))) : NO_MARKS;
  return { loaded, marks };
}
