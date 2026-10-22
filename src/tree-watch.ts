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
  now?: () => number; // Date.now by default; read at call time, so a test's mocked Date is the one read
}

export interface TreeWatch {
  /** Starts or renews a lease; `isCheckout` (a workspace's checkout, #633, #444) drops the other activities' worktrees under it. */
  lease(activityId: string, root: string, id: string, isCheckout: boolean): Promise<void>;
  release(id: string): void;
  watchNested(root: string, repo: string): Promise<void>; // the folder route's (#1); a root with no lease is ignored
  close(): void;
}

interface Lease { activityId: string; root: string; expiry: ReturnType<typeof setTimeout> }

export function createTreeWatch(deps: TreeWatchDeps): TreeWatch {
  const leases = new Map<string, Lease>();
  const roots = new Map<string, RootWatch>();
  const logged = new Set<string>(); // roots whose watch failure is already in hive.log: once per root
  const now = deps.now ?? ((): number => Date.now());
  // Sorted and once per activity: two windows on one activity hold two leases but want one read
  const activitiesOn = (root: string): string[] => [...new Set([...leases.values()].filter((lease) => lease.root === root).map((lease) => lease.activityId))].sort();
  const pushTo = (root: string) => (paths: string[] | undefined): void => {
    for (const activityId of activitiesOn(root)) deps.notify({ type: 'tree', activityId, ...(paths === undefined ? {} : { paths }) });
  };
  const onFail = (root: string) => (reason: string): void => {
    if (logged.has(root)) return;
    logged.add(root);
    deps.log.warn(`tree watch: ${root}: ${reason}; polling git status every ${FALLBACK_SECONDS} s`);
  };
  const stopIfUnleased = (root: string): void => {
    if (activitiesOn(root).length > 0) return;
    roots.get(root)?.close();
    roots.delete(root);
  };
  const release = (id: string): void => {
    const lease = leases.get(id);
    if (lease === undefined) return;
    clearTimeout(lease.expiry);
    leases.delete(id);
    stopIfUnleased(lease.root);
  };
  return {
    lease(activityId, root, id, isCheckout) {
      const previous = leases.get(id);
      if (previous !== undefined) clearTimeout(previous.expiry);
      leases.set(id, { activityId, root, expiry: setTimeout(() => release(id), LEASE_TTL_MS) });
      if (previous !== undefined && previous.root !== root) stopIfUnleased(previous.root);
      const watch = roots.get(root) ?? createRootWatch(root, isCheckout, { log: deps.log, exec: deps.exec, watch: deps.watch ?? nodeWatch, now, push: pushTo(root), onFail: onFail(root) });
      roots.set(root, watch);
      return watch.ready;
    },
    release,
    watchNested: (root, repo) => roots.get(root)?.watchNested(repo) ?? Promise.resolve(),
    close() {
      for (const lease of leases.values()) clearTimeout(lease.expiry);
      leases.clear();
      for (const watch of roots.values()) watch.close();
      roots.clear();
    },
  };
}
