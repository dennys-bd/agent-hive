import { watch as fsWatch } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Logger } from './log.js';
import type { Exec } from './types.js';
import { wordsOf } from './worktree.js';

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

export interface Watcher { close(): void; on(event: 'error', listener: (err: Error) => void): unknown }
export type WatchFn = (path: string, options: { recursive: boolean }, listener: (eventType: string, filename: string | null) => void) => Watcher;

// persistent: false: a watch is never what keeps the daemon alive (spec: daemon shutdown); close() still closes each
export const nodeWatch: WatchFn = (path, { recursive }, listener) =>
  fsWatch(path, { recursive, persistent: false, encoding: 'utf8' }, (eventType, filename) => listener(eventType, filename));

export interface RootDeps { log: Pick<Logger, 'warn' | 'debug'>; exec: Exec; watch: WatchFn; now(): number; push(paths: string[] | undefined): void; onFail(reason: string): void }
export interface RootWatch { ready: Promise<void>; watchNested(repo: string): Promise<void>; close(): void }

/** The changes gathered for one push (#502): COALESCE_MS after the first, never sooner than MIN_PUSH_MS after the last push; past PATHS_CAP,
 *  or with an undefined path (anything), the push carries no paths. */
export function createBatch(now: () => number, push: (paths: string[] | undefined) => void): { add(path: string | undefined): void; close(): void } {
  let pending: Set<string> | 'all' | undefined; // the batch's own scratch, never handed out: flush sorts a copy
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPush = Number.NEGATIVE_INFINITY;
  const flush = (): void => {
    const paths = pending === 'all' || pending === undefined ? undefined : [...pending].sort();
    timer = undefined;
    pending = undefined;
    lastPush = now();
    push(paths);
  };
  return {
    add(path) {
      if (path === undefined || pending === 'all') pending = 'all';
      else {
        const paths: Set<string> = pending ?? new Set<string>();
        paths.add(path);
        pending = paths.size > PATHS_CAP ? 'all' : paths;
      }
      timer ??= setTimeout(flush, Math.max(COALESCE_MS, lastPush + MIN_PUSH_MS - now()));
    },
    close() {
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}

export function createRootWatch(root: string, isCheckout: boolean, deps: RootDeps): RootWatch {
  const batch = createBatch(deps.now, deps.push);
  const watchers = new Map<string, Watcher>(); // '' the tree; Task 6 adds the gitdirs
  const closeAll = (): void => { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); batch.close(); };
  const onTree = (filename: string | null): void => {
    // a null name: the platform named nothing, so anything may have changed
    const path = filename === null ? undefined : filename.split(sep).join('/');
    const kind = path === undefined ? 'git' : pathKind(path, isCheckout);
    if (kind !== 'drop') batch.add(kind === 'git' ? undefined : path);
  };
  const tree = deps.watch(root, { recursive: true }, (_eventType, filename) => onTree(filename));
  tree.on('error', (err) => deps.log.debug(`tree watch: ${root}: ${wordsOf(err)}`)); // Task 7 turns this into the fallback
  watchers.set('', tree);
  return { ready: Promise.resolve(), watchNested: async () => undefined, close: closeAll };
}
