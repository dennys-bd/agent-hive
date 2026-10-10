import { type RefObject, useEffect, useRef } from 'react';
import type { OperationId } from '../../types';
import type { TreeActions } from '@/components/tree-ops';
import { onShortcutKey } from '@/lib/dock-layout';

// The files tree's keys (#818): the `files` scope's shortcuts, acting only while the focus is in the tree and not in its inline input. A
// dialog takes the focus out of the tree, so its Enter confirms it and never renames. Cut, copy and paste are the DOM's own events
// (tree-paste.ts), not these.

export type TreeKey = 'newFile' | 'newFolder' | 'rename' | 'trash' | 'reveal' | 'terminal' | 'copyPath' | 'copyRelativePath';

const TREE_KEYS: ReadonlyArray<[TreeKey, OperationId]> = [
  ['newFile', 'treeNewFile'], ['newFolder', 'treeNewFolder'], ['rename', 'treeRename'], ['trash', 'treeDelete'], ['reveal', 'treeReveal'],
  ['terminal', 'treeOpenTerminal'], ['copyPath', 'treeCopyPath'], ['copyRelativePath', 'treeCopyRelativePath'],
];
const NEEDS_ROW: readonly TreeKey[] = ['rename', 'trash', 'copyPath', 'copyRelativePath'];

const isInTree = (target: EventTarget | null, tree: HTMLElement | null): boolean =>
  tree !== null && target instanceof Element && tree.contains(target) && target.closest('[data-tree-input]') === null;

// The row the keyboard's focus is on: its path and its drop folder (a folder's own path, a file's folder); none on the tree's empty area
function focusedRow(): { path: string; folder: string } | undefined {
  const row = document.activeElement?.closest<HTMLElement>('[data-tree-path]');
  return row ? { path: row.dataset.treePath ?? '', folder: row.dataset.treeFolder ?? '' } : undefined;
}

/** What a tree key does on the focused row (#818); with none, a new item, the terminal and reveal act on the root and the rest do nothing. */
export function runTreeKey(key: TreeKey, actions: TreeActions, selectedOf: (path: string) => string[]): void {
  const row = focusedRow();
  if (row === undefined && NEEDS_ROW.includes(key)) return;
  const path = row?.path ?? '';
  const folder = row?.folder ?? '';
  const run: Record<TreeKey, () => void> = {
    newFile: () => actions.newItem('file', folder),
    newFolder: () => actions.newItem('folder', folder),
    rename: () => actions.rename(path),
    trash: () => actions.trash(selectedOf(path)),
    reveal: () => actions.reveal(path),
    terminal: () => actions.openTerminal(folder),
    copyPath: () => actions.copyPath(path),
    copyRelativePath: () => actions.copyRelativePath(path),
  };
  run[key]();
}

/** Mounted with the tree: its keys reach `onKey`, the latest one, only with the focus inside `tree`. */
export function useTreeKeys(tree: RefObject<HTMLElement | null>, onKey: (key: TreeKey) => void): void {
  const latest = useRef(onKey);
  useEffect(() => {
    latest.current = onKey;
  });
  useEffect(() => onShortcutKey(TREE_KEYS, (key) => latest.current(key), (event) => isInTree(event.target, tree.current)), [tree]);
}
