import { watch as fsWatch } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { gitIn } from './git-status.js';
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
const ROOT_GITDIR = '.git'; // a key no nested repository can have: git never names one .git
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
export function createBatch(now: () => number, push: (paths: string[] | undefined) => void): { add(path: string | undefined): void; flush(): void; close(): void } {
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
    // Whatever is waiting goes out now with no paths: the caller is about to stop watching, so which paths changed is no longer known
    flush() {
      if (pending === undefined) return;
      clearTimeout(timer);
      pending = 'all';
      flush();
    },
    close() {
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}

// The grouped poll's one run (#502): with -uall and matching, any change git can list changes a line; # branch.oid and # branch.head catch a
// commit and a switch. An edit inside an ignored folder changes no line: in this mode it shows on window focus or after the sidebar's own
// operations, and a nested repository's stage or commit only on focus (the outer status does not see it)
export const FALLBACK_STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=matching'];

function startFallback(root: string, { exec, log, push }: Pick<RootDeps, 'exec' | 'log' | 'push'>): { close(): void } {
  let last: string | undefined;
  let isRunning = false;
  let isClosed = false;
  const tick = async (): Promise<void> => {
    if (isRunning) return; // a slow git never stacks runs
    isRunning = true;
    try {
      const output = await gitIn(root, FALLBACK_STATUS_ARGS, exec);
      if (!isClosed && last !== undefined && output !== last) push(undefined);
      last = output;
    } catch (err) {
      log.debug(`tree watch: ${root}: status failed: ${wordsOf(err)}`); // the root may be gone: its lease ends with its activity
    } finally {
      isRunning = false;
    }
  };
  void tick(); // the baseline the first tick compares with
  const timer = setInterval(() => void tick(), FALLBACK_MS);
  return { close: () => { isClosed = true; clearInterval(timer); } };
}

/** The gitdir of the repository at `folder` (#502): its .git folder, or the one its .git file names (a worktree's); undefined without either. */
export async function gitDirFor(folder: string): Promise<string | undefined> {
  const dotGit = join(folder, '.git');
  const stat = await lstat(dotGit).catch(() => undefined);
  if (stat === undefined) return undefined;
  return stat.isDirectory() ? dotGit : gitDirOf(await readFile(dotGit, 'utf8'), folder);
}

function treeListener(batch: { add(path: string | undefined): void }, isCheckout: boolean): (filename: string | null) => void {
  return (filename) => {
    // a null name: the platform named nothing, so anything may have changed
    const path = filename === null ? undefined : filename.split(sep).join('/');
    const kind = path === undefined ? 'git' : pathKind(path, isCheckout);
    if (kind !== 'drop') batch.add(kind === 'git' ? undefined : path);
  };
}

export function createRootWatch(root: string, isCheckout: boolean, deps: RootDeps): RootWatch {
  const batch = createBatch(deps.now, deps.push);
  const watchers = new Map<string, Watcher>(); // '' the tree, ROOT_GITDIR the root's gitdir, a nested repository's path its gitdir
  let isClosed = false;
  let poll: { close(): void } | undefined;
  const isWatching = (): boolean => !isClosed && poll === undefined;
  const closeAll = (): void => { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); batch.close(); };
  // Any failure of the tree's or the root gitdir's watch: one git status for the whole root instead, nested repositories included
  const rootFailed = (err: unknown): void => {
    if (!isWatching()) return;
    batch.flush(); // a change already seen is not lost to the switch
    closeAll();
    deps.onFail(wordsOf(err));
    poll = startFallback(root, deps);
  };
  const open = (key: string, path: string, recursive: boolean, onEvent: (filename: string | null) => void, onError: (err: unknown) => void): void => {
    try {
      const watcher = deps.watch(path, { recursive }, (_eventType, filename) => onEvent(filename));
      watcher.on('error', onError);
      watchers.set(key, watcher);
    } catch (err) {
      onError(err);
    }
  };
  // git replaces index and HEAD by renaming a lock over them: a watch on the folder survives that, one on the file goes dead after the first
  const onGitDir = (as: string | undefined) => (filename: string | null): void => {
    if (filename === null || GIT_FILES.has(filename)) batch.add(as);
  };
  open('', root, true, treeListener(batch, isCheckout), rootFailed);
  // A checkout's own .git folder is already inside the recursive watch; a .git file (a worktree used as the checkout) names a gitdir outside it
  const ready = gitDirFor(root).then(
    (dir) => { if (dir !== undefined && isWatching() && !(isCheckout && dir === join(root, '.git'))) open(ROOT_GITDIR, dir, false, onGitDir(undefined), rootFailed); },
    (err: unknown) => deps.log.debug(`tree watch: ${root}: no gitdir read: ${wordsOf(err)}`),
  );
  // Only an expanded nested repository is watched: #289's marks of a folder never opened stay as last read
  const watchNested = async (repo: string): Promise<void> => {
    if (!isWatching() || watchers.has(repo)) return;
    const dir = await gitDirFor(join(root, repo)).catch(() => undefined);
    if (dir === undefined || !isWatching() || watchers.has(repo)) return; // checked again: a second call may have opened it while this one read
    // A nested repository's failure costs only its own push: the tree's watch goes on, and the next folder read registers it again
    open(repo, dir, false, onGitDir(repo), (err) => {
      watchers.get(repo)?.close();
      watchers.delete(repo);
      deps.log.debug(`tree watch: ${root}: ${repo}: ${wordsOf(err)}`);
    });
  };
  return { ready, watchNested, close: () => { isClosed = true; closeAll(); poll?.close(); } };
}
