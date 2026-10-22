import { useEffect, useState } from 'react';
import type { FolderEntries, GitMark } from '../../types';
import { getJson } from '../lib/api.js';
import { ignoredToRead } from '../lib/file-tree.js';
import { foldersToReread } from '../lib/tree-change.js';
import { onTreeEvent } from '../lib/tree-events.js';
import { onTreeChanged } from '../lib/tree-place.js';
import { rememberMarks } from '../lib/tree-status.js';

const NONE: ReadonlyMap<string, FolderEntries> = new Map();
const NO_MARKS: Readonly<Record<string, GitMark>> = {};

/** What useIgnoredFolders reads: the open folders' children, and every nested repository mark read so far by full path (#289). */
export interface LoadedFolders { loaded: ReadonlyMap<string, FolderEntries>; marks: Readonly<Record<string, GitMark>> }

// The marks belong to one activity: another one's must never colour this tree, even for the render before its first read
interface Remembered { activityId: string; marks: Readonly<Record<string, GitMark>> }
const folderUrl = (activityId: string, path: string): string => `/activities/${encodeURIComponent(activityId)}/tree/folder?path=${encodeURIComponent(path)}`;

// A failed read keeps what the folder last showed: one transient error must not collapse an open subtree; a deleted folder leaves the tree
// anyway, with its parent's next read. Only the folders still to read stay in the map
function mergeLoaded(prev: ReadonlyMap<string, FolderEntries>, paths: readonly string[], fresh: ReadonlyMap<string, FolderEntries>): ReadonlyMap<string, FolderEntries> {
  return new Map(paths.flatMap((path) => {
    const entries = fresh.get(path) ?? prev.get(path);
    return entries ? [[path, entries] as const] : [];
  }));
}

/** The children on disk of every expanded ignored folder, and of every expanded folder under one (HIVE-22), by path. Read when shown, on each
 *  `tree` event of the activity for the folders its paths reach (#502), on each window focus and after each tree operation (onTreeChanged); a collapsed ignored folder is never read. A
 *  folder whose read fails (moved, deleted) leaves the map with no toast: the tree still shows it, unloaded. A collapsed folder's marks stay
 *  as last read (#289), with no re-read, so they keep raising the folders above it; they reset with the activity, and those under a folder
 *  no longer ignored (deleted, renamed) are left out. */
export function useIgnoredFolders(activityId: string, isShown: boolean, expanded: ReadonlySet<string>, ignoredFolders: readonly string[] | undefined): LoadedFolders {
  const [loaded, setLoaded] = useState(NONE);
  const [remembered, setRemembered] = useState<Remembered>({ activityId, marks: NO_MARKS });
  // Reset during render, not in an effect, so a switch back to the previous activity can never show its old marks
  if (remembered.activityId !== activityId) setRemembered({ activityId, marks: NO_MARKS });
  // A key, not the set: each toggle and each read make new objects, and only a change in what to read must restart the reads
  const key = ignoredToRead(expanded, ignoredFolders ?? []).join('\0');
  useEffect(() => {
    const paths = key === '' ? [] : key.split('\0');
    if (!isShown || paths.length === 0) {
      setLoaded(NONE);
      return undefined;
    }
    let live = true;
    let isReading = false;
    let queued: ReadonlySet<string> = new Set(); // asked for while a round flew: read as soon as that one settles
    const read = (targets: readonly string[]): void => {
      if (targets.length === 0) return;
      if (isReading) {
        queued = new Set([...queued, ...targets]);
        return;
      }
      isReading = true;
      void Promise.allSettled(targets.map((path) => getJson<FolderEntries>(folderUrl(activityId, path)))).then((results) => {
        isReading = false;
        if (!live) return;
        const fresh = new Map(results.flatMap((result, i) => (result.status === 'fulfilled' ? [[targets[i], result.value] as const] : [])));
        setLoaded((prev) => mergeLoaded(prev, paths, fresh));
        setRemembered((prev) => ({ activityId, marks: rememberMarks(prev.activityId === activityId ? prev.marks : NO_MARKS, fresh) }));
        const next = paths.filter((path) => queued.has(path));
        queued = new Set();
        read(next);
      });
    };
    const readAll = (): void => read(paths);
    readAll();
    const stops = [
      onTreeChanged(activityId, readAll),
      onTreeEvent((change) => { if (change.activityId === activityId) read(foldersToReread(change.paths, paths)); }), // #502
    ];
    window.addEventListener('focus', readAll);
    return () => { live = false; for (const stop of stops) stop(); window.removeEventListener('focus', readAll); };
  }, [activityId, isShown, key]);
  const roots = ignoredFolders ?? [];
  const isUnderRoot = (path: string): boolean => roots.some((root) => path.startsWith(`${root}/`));
  const marks = remembered.activityId === activityId ? Object.fromEntries(Object.entries(remembered.marks).filter(([path]) => isUnderRoot(path))) : NO_MARKS;
  return { loaded, marks };
}
