import type { Logger } from './log.js';
import { createRootWatch, FALLBACK_MS, nodeWatch, type RootWatch, type WatchFn } from './tree-watch-root.js';
import type { Exec, TreeChange } from './types.js';

// The files sidebar's watches (#502): which roots are leased, by whom, and until when.
export { COALESCE_MS, FALLBACK_MS, gitDirOf, MIN_PUSH_MS, pathKind, PATHS_CAP, type WatchFn } from './tree-watch-root.js';

const FALLBACK_SECONDS = FALLBACK_MS / 1000;
export const LEASE_TTL_MS = 30_000; // a page that crashed or closed leaves no watch running past it

export interface TreeWatchDeps {
  log: Pick<Logger, 'warn' | 'debug'>;
  notify(change: TreeChange): void; // the named `tree` event on /events
  exec: Exec; // the fallback's git status (Task 7)
  watch?: WatchFn; // node:fs watch by default; tests pass a fake
  now?: () => number; // performance.now by default; a test passes its own
}

export interface TreeWatch {
  /** Starts or renews a lease; `isCheckout` (a workspace's checkout, #633, #444) drops the other activities' worktrees under it. */
  lease(activityId: string, root: string, id: string, isCheckout: boolean): Promise<void>;
  release(activityId: string, id: string): void; // a lease of another activity, or none, is a no-op
  watchNested(root: string, repo: string): Promise<void>; // the folder route's (#1); a root with no lease is ignored
  close(): void;
}

interface Lease { activityId: string; root: string; expiry: ReturnType<typeof setTimeout> }

export const MAX_LEASES = 256; // one per shown sidebar per window: far above any real use, a bound on a buggy or hostile page
export const TOO_MANY_LEASES_MESSAGE = 'too many tree watch leases';
export class TooManyLeasesError extends Error {
  constructor() { super(TOO_MANY_LEASES_MESSAGE); }
}

// Sorted and once per activity: two windows on one activity hold two leases but want one read
const activitiesOn = (leases: ReadonlyMap<string, Lease>, root: string): string[] =>
  [...new Set([...leases.values()].filter((lease) => lease.root === root).map((lease) => lease.activityId))].sort();

// Once per root, in hive.log: a root that keeps failing would fill it
const failLogger = (log: TreeWatchDeps['log'], logged: Set<string>) => (root: string) => (reason: string): void => {
  if (logged.has(root)) return;
  logged.add(root);
  log.warn(`tree watch: ${root}: ${reason}; polling git status every ${FALLBACK_SECONDS} s`);
};

export function createTreeWatch(deps: TreeWatchDeps): TreeWatch {
  const leases = new Map<string, Lease>();
  const roots = new Map<string, RootWatch>();
  const onFail = failLogger(deps.log, new Set<string>());
  // Monotonic: the spacing of pushes must not stretch or shrink when the wall clock is stepped (NTP, sleep)
  const now = deps.now ?? ((): number => performance.now());
  const pushTo = (root: string) => (paths: string[] | undefined): void => {
    for (const activityId of activitiesOn(leases, root)) deps.notify({ type: 'tree', activityId, ...(paths === undefined ? {} : { paths }) });
  };
  const stopIfUnleased = (root: string): void => {
    if (activitiesOn(leases, root).length > 0) return;
    roots.get(root)?.close();
    roots.delete(root);
  };
  const drop = (id: string): void => {
    const lease = leases.get(id);
    if (lease === undefined) return;
    clearTimeout(lease.expiry);
    leases.delete(id);
    stopIfUnleased(lease.root);
  };
  const startRoot = (root: string, isCheckout: boolean): RootWatch =>
    roots.get(root) ?? createRootWatch(root, isCheckout, { log: deps.log, exec: deps.exec, watch: deps.watch ?? nodeWatch, now, push: pushTo(root), onFail: onFail(root) });
  return {
    lease(activityId, root, id, isCheckout) {
      const previous = leases.get(id);
      if (previous === undefined && leases.size >= MAX_LEASES) return Promise.reject(new TooManyLeasesError());
      if (previous !== undefined) clearTimeout(previous.expiry);
      leases.set(id, { activityId, root, expiry: setTimeout(() => drop(id), LEASE_TTL_MS) });
      if (previous !== undefined && previous.root !== root) stopIfUnleased(previous.root);
      const watch = startRoot(root, isCheckout);
      roots.set(root, watch);
      return watch.ready;
    },
    // Only the activity that took a lease may end it: an id from another page's activity is no business of this one
    release(activityId, id) { if (leases.get(id)?.activityId === activityId) drop(id); },
    watchNested: (root, repo) => roots.get(root)?.watchNested(repo) ?? Promise.resolve(),
    close() {
      for (const lease of leases.values()) clearTimeout(lease.expiry);
      leases.clear();
      for (const watch of roots.values()) watch.close();
      roots.clear();
    },
  };
}
