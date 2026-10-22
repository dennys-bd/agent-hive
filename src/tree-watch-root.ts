import { resolve } from 'node:path';

// One leased root's watch (#502): the tree, recursively, and its git's index and HEAD; pushes coalesced and capped; a grouped poll when
// fs.watch fails.

export const COALESCE_MS = 250; // a burst's changes gathered after its first
export const MIN_PUSH_MS = 1_000; // at most one push a second per root: a build costs at most one read a second
export const PATHS_CAP = 200; // past it the push carries no paths: anything may have changed
export const FALLBACK_MS = 5_000; // the grouped poll's period

const GIT_FILES = new Set(['index', 'HEAD']);
const WORKTREES = '.hive/worktrees'; // the other activities' worktrees inside a workspace's checkout
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

/** What a changed path is worth to the page (#502): `git` for the root's own `.git/index` and `.git/HEAD` (a push with no paths), `drop`
 *  for any other `.git` path (every worker's git writes the main .git) and, under a checkout, for the other activities' worktrees. Pure. */
export type PathKind = 'drop' | 'git' | 'path';
export function pathKind(path: string, isCheckout: boolean): PathKind {
  const parts = path.split('/');
  // case-insensitive as tree-paths.ts's: APFS resolves `.GIT` to `.git`
  const gitAt = parts.findIndex((part) => part.toLowerCase() === '.git');
  if (gitAt === 0 && parts.length === 2 && GIT_FILES.has(parts[1])) return 'git';
  if (gitAt !== -1) return 'drop';
  return isCheckout && (path === WORKTREES || path.startsWith(`${WORKTREES}/`)) ? 'drop' : 'path';
}

/** The gitdir a worktree's `.git` file names (#502), read with fs, no git; a relative one against the folder holding the file. Pure. */
export function gitDirOf(dotGit: string, folder: string): string | undefined {
  const match = GITDIR_LINE.exec(dotGit);
  return match === null ? undefined : resolve(folder, match[1]);
}
