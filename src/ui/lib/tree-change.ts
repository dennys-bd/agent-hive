// What a tree event (#502) asks the files sidebar to read again, from its paths alone: no git, no request. Pure, so node:test imports it from
// dist/src/ui/lib as file-tree.ts.
import type { IgnoredEntries } from '../../types.js';

// The folder itself counts (Q1 (a)): a nested repository's own git change arrives as its folder's path, and reads only what is expanded under it
const isWithin = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/** Whether a tree event reads the tree again: with no paths (anything changed), before any answer, or when a path is neither an ignored
 *  file of the last answer nor in one of its ignored folders. A path the tree does not know yet counts as not ignored. */
export function isTreeRead(paths: readonly string[] | undefined, ignored: IgnoredEntries | undefined): boolean {
  if (paths === undefined || ignored === undefined) return true;
  return paths.some((path) => !ignored.files.includes(path) && !ignored.folders.some((folder) => isWithin(path, folder)));
}

/** The expanded folders (ignoredToRead's) a tree event reads again: all with no paths; else each a path lies in at any depth, and each under
 *  a path, which is how a nested repository's stage, commit or switch arrives (`paths: [repo]`, #1). In `folders`' order. */
export function foldersToReread(paths: readonly string[] | undefined, folders: readonly string[]): string[] {
  if (paths === undefined) return [...folders];
  return folders.filter((folder) => paths.some((path) => isWithin(path, folder) || isWithin(folder, path)));
}
