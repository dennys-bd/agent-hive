// The files tree follows the editor (#718), as VS Code's explorer auto reveal does: the active file's folders open, its row selected and
// brought into view. Never for a file outside the root, a hidden one with ocultos off, or one under an ignored folder that is no nested
// repository (node_modules must not unfold).
import { type RefObject, useEffect, useEffectEvent, useState } from 'react';
import type { FolderEntries } from '../../types';
import { isDrivePath } from '../../lsp-uri';
import { getJson } from '../lib/api.js';
import { isHidden } from '../lib/file-tree.js';
import { folderUrl } from './use-ignored-folders.js';

/** What the tree does for an active file: nothing, reveal it, or read the ignored folder it lies under first. */
export type RevealOf = 'none' | 'reveal' | { check: string };

/** Whether the tree reveals `path` (spec decisions 4 and 5). An ignored folder is checked from the outermost one, since a nested
 *  repository's own ignored folders are listed under it and must not decide for it. */
export function revealOf(path: string, ignoredFolders: readonly string[], showHidden: boolean): RevealOf {
  if (path.startsWith('/') || isDrivePath(path) || (!showHidden && isHidden(path))) return 'none';
  const under = ignoredFolders.filter((folder) => path.startsWith(`${folder}/`));
  if (under.length === 0) return 'reveal';
  return { check: under.reduce((outer, folder) => (folder.length < outer.length ? folder : outer)) };
}

/** Calls `reveal(activeFile)` when the tree mounts and on each change of `activeFile`, once the tree's first read gave its ignored folders.
 *  `TaskTree.ignored.folders` mixes nested repositories and plain ignored folders, so a path under one reads that folder and reveals only
 *  when the answer has `repo`. A failed read reveals nothing, and an answer after `activeFile` moved on is dropped. */
export function useTreeReveal(activityId: string, activeFile: string | undefined, ignoredFolders: readonly string[] | undefined, showHidden: boolean, reveal: (path: string) => void): void {
  const isReady = ignoredFolders !== undefined; // a tree that has read once stays read: a failed poll keeps it (useTaskTree)
  // Read at the change, never dependencies: a tree poll or a toggle of ocultos must not reveal again (decision 6)
  const decide = useEffectEvent((path: string): RevealOf => revealOf(path, ignoredFolders ?? [], showHidden));
  const onReveal = useEffectEvent((path: string): void => reveal(path));
  useEffect(() => {
    if (!isReady || activeFile === undefined) return undefined;
    const decision = decide(activeFile);
    if (decision === 'none') return undefined;
    if (decision === 'reveal') {
      onReveal(activeFile);
      return undefined;
    }
    let live = true;
    getJson<FolderEntries>(folderUrl(activityId, decision.check)).then(
      (entries) => { if (live && entries.repo !== undefined) onReveal(activeFile); },
      () => undefined, // a folder that cannot be read leaves the tree as it was; the tree's own read reports what is wrong with it
    );
    return () => { live = false; };
  }, [activityId, activeFile, isReady]);
}

/** The row of the last path asked for, brought into view once it is among the rendered rows (decision 7), then forgotten; a new path
 *  replaces the old one. `nearest` leaves a row already in view where it is, so a click in the tree does not jump. */
export function usePendingScroll(container: RefObject<HTMLElement | null>): (path: string) => void {
  const [pending, setPending] = useState<string | undefined>();
  useEffect(() => { // after every render: an ignored folder's rows arrive with its read, a few renders after the reveal
    if (pending === undefined) return;
    const rows = Array.from(container.current?.querySelectorAll('[data-tree-path]') ?? []);
    // matched by value, not by a [data-tree-path="..."] selector, so a path with quotes or brackets needs no escaping
    const row = rows.find((el) => el.getAttribute('data-tree-path') === pending);
    if (row === undefined) return;
    row.scrollIntoView({ block: 'nearest' });
    setPending(undefined);
  });
  return setPending;
}
