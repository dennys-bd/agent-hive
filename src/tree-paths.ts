// The files tree's path guards (#594, #818), shared by tree/move (server-move.ts) and the tree's own operations (server-tree-ops.ts): every
// path a route takes is relative to the tree's root and stays inside it, as written and as real (a symlink out is refused), and never
// reaches .git. Every disk touch goes through PathFs, so node:test can fake one.
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isInside } from './ide.js';
import type { Refusal } from './server-tasks.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
export const OUTSIDE_MESSAGE = "path outside the task's folder";
export const GIT_MESSAGE = '.git cannot be moved or written into'; // the local activity's root is the workspace checkout
export const ABSOLUTE_MOVE_MESSAGE = 'an absolute source can only be copied in';
export const FOLDER_MISSING_MESSAGE = 'folder not found';
export const MISSING_FILE_MESSAGE = 'file not found';

export interface PathFs {
  realpath(path: string): Promise<string>; // rejects when the path does not exist
  stat(path: string): Promise<{ isDirectory(): boolean }>; // rejects when the path does not exist
}

// lstat, not stat: a symlink is the item, not its target, and a dangling one still holds its name, so no free name lands on it
export const PATH_DISK: PathFs = { realpath: (path) => realpath(path), stat: (path) => lstat(path) };

/** The tree's root as written and as real: every guard checks a path against both. */
export interface Roots { root: string; realRoot: string }

export const rootsOf = async (root: string, fs: PathFs): Promise<Roots> => ({ root, realRoot: await fs.realpath(root) });
export const refusal = (status: number, message: string): Refusal => ({ status, message });
export const exists = (fs: PathFs, path: string): Promise<boolean> => fs.stat(path).then(() => true, () => false);
export const isRootOrInside = (base: string, target: string): boolean => target === base || isInside(base, target);
// Any segment, not only the first (a nested checkout's .git/hooks runs code), and case-insensitive: APFS resolves `.GIT` to `.git` by default
const isGitPath = (root: string, target: string): boolean => relative(root, target).split(sep).some((segment) => segment.toLowerCase() === '.git');

/** The folder a drop lands in (#594), or a terminal starts in (#818): relative ('' is the root), inside the root as written and as real (a
 *  symlink out is refused), and a folder. Its real path. */
export async function destination({ root, realRoot }: Roots, into: string, fs: PathFs): Promise<string | Refusal> {
  const target = resolve(root, into);
  if (isAbsolute(into) || !isRootOrInside(root, target)) return refusal(HTTP_BAD_REQUEST, OUTSIDE_MESSAGE);
  if (isGitPath(root, target)) return refusal(HTTP_BAD_REQUEST, GIT_MESSAGE);
  const real = await fs.realpath(target).catch(() => undefined);
  if (real === undefined) return refusal(HTTP_BAD_REQUEST, FOLDER_MISSING_MESSAGE);
  if (!isRootOrInside(realRoot, real)) return refusal(HTTP_BAD_REQUEST, OUTSIDE_MESSAGE);
  if (isGitPath(realRoot, real)) return refusal(HTTP_BAD_REQUEST, GIT_MESSAGE); // a symlink to .git
  const isFolder = await fs.stat(real).then((s) => s.isDirectory(), () => false);
  return isFolder ? real : refusal(HTTP_BAD_REQUEST, FOLDER_MISSING_MESSAGE);
}

/** A dragged item's real place (#594): its parent folder resolved, its own name kept, so a symlink moves as the link. A relative source stays
 *  inside the root like `into`; an absolute one is only ever a Finder file, copied in, and may be anywhere (the daemon's secret gates the
 *  route, #467). */
export async function sourceItem({ root, realRoot }: Roots, source: string, copy: boolean, fs: PathFs): Promise<string | Refusal> {
  const isFromFinder = isAbsolute(source);
  // A move would remove the original, and an absolute path may lie anywhere: only a copy may take one in (Finder's drop always copies)
  if (isFromFinder && !copy) return refusal(HTTP_BAD_REQUEST, ABSOLUTE_MOVE_MESSAGE);
  const target = resolve(root, source);
  if (!isFromFinder && !isInside(root, target)) return refusal(HTTP_BAD_REQUEST, OUTSIDE_MESSAGE);
  if (!isFromFinder && isGitPath(root, target)) return refusal(HTTP_BAD_REQUEST, GIT_MESSAGE);
  const parent = await fs.realpath(dirname(target)).catch(() => undefined);
  if (parent === undefined) return refusal(HTTP_NOT_FOUND, MISSING_FILE_MESSAGE);
  const item = join(parent, basename(target));
  if (!isFromFinder && !isInside(realRoot, item)) return refusal(HTTP_BAD_REQUEST, OUTSIDE_MESSAGE);
  if (!isFromFinder && isGitPath(realRoot, item)) return refusal(HTTP_BAD_REQUEST, GIT_MESSAGE); // a symlinked parent to .git
  return (await exists(fs, item)) ? item : refusal(HTTP_NOT_FOUND, MISSING_FILE_MESSAGE);
}

/** An existing item of the tree (#818): a relative path, checked as a dragged one is; an absolute one is refused. */
export const existingItem = (roots: Roots, path: string, fs: PathFs): Promise<string | Refusal> =>
  (isAbsolute(path) ? Promise.resolve(refusal(HTTP_BAD_REQUEST, OUTSIDE_MESSAGE)) : sourceItem(roots, path, false, fs));

// `target` through the deepest folder above it that exists, made real: the root always exists, so the walk ends there at the latest
async function throughNearestReal(root: string, target: string, fs: PathFs): Promise<string> {
  for (let folder = dirname(target); ; folder = dirname(folder)) {
    const real = await fs.realpath(folder).catch(() => undefined);
    if (real !== undefined) return join(real, relative(folder, target));
    if (folder === root || folder === dirname(folder)) return target;
  }
}

/** A path that may not exist yet (#818): a new file or folder, a rename's target. Relative, inside the root as written and through its
 *  nearest existing folder's real path (a symlink out is refused), never under .git. Its real-based absolute path. */
export async function newItem({ root, realRoot }: Roots, path: string, fs: PathFs): Promise<string | Refusal> {
  const target = resolve(root, path);
  if (isAbsolute(path) || !isInside(root, target)) return refusal(HTTP_BAD_REQUEST, OUTSIDE_MESSAGE);
  if (isGitPath(root, target)) return refusal(HTTP_BAD_REQUEST, GIT_MESSAGE);
  const item = await throughNearestReal(root, target, fs);
  if (!isInside(realRoot, item)) return refusal(HTTP_BAD_REQUEST, OUTSIDE_MESSAGE);
  return isGitPath(realRoot, item) ? refusal(HTTP_BAD_REQUEST, GIT_MESSAGE) : item;
}

/** Once each (#594): a repeated item, or one under another item, would fail on a path the first already moved or trashed. */
export const outermost = (items: string[]): string[] => [...new Set(items)].filter((item) => !items.some((other) => other !== item && isInside(other, item)));

/** A folder of the tree a terminal starts in (#818): destination's checks, from the root alone. */
export const treeFolder = async (root: string, folder: string, fs: PathFs = PATH_DISK): Promise<string | Refusal> => destination(await rootsOf(root, fs), folder, fs);

/** An existing item of the tree a reveal shows (#818). */
export const treeItem = async (root: string, path: string, fs: PathFs = PATH_DISK): Promise<string | Refusal> => existingItem(await rootsOf(root, fs), path, fs);
