import type { Logger } from '../log.js';
import type { ReadModel } from './db.js';
import { reconcile, refetchIssue } from './reconcile.js';
import type { RestGet } from './rest.js';
import { EMPTY_REPORT, mergeReports, scopeOf, syncScope, type SyncDeps, type SyncReport } from './sync.js';

export const READ_SYNC_INTERVAL_MS = 60_000; // the spec's cadence: one round a minute over the listed repositories
export const REFETCH_COOLDOWN_MS = 10_000; // a page opened again within this long does not start another gh run
export const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;

/** One repository's sync (#765): its issues, then its comments (whose issues the first scope stored), then the reconciliation when due.
 * `stored` hears of each scope that changed a row as it ends, so a later scope's failure does not hide it. */
export async function syncRepository(deps: SyncDeps, repository: string, reconcileDue: boolean, stored: () => void): Promise<SyncReport> {
  const scopes = [() => syncScope(deps, repository, 'issues'), () => syncScope(deps, repository, 'comments'), ...(reconcileDue ? [() => reconcile(deps, repository)] : [])];
  let report = EMPTY_REPORT;
  for (const run of scopes) {
    const done = await run();
    if (done.changed) stored();
    report = mergeReports(report, done);
  }
  return report;
}

export interface ReadModelLoopDeps {
  db: ReadModel;
  source: string;
  rest: RestGet;
  repositories(): Promise<string[]>; // what listRepositories lists now; none before a config
  notify(source: string, repository: string): void; // the readModel event
  log: Pick<Logger, 'error' | 'debug'>;
  now?: () => Date;
}

export interface ReadModelLoop { runOnce(): Promise<void>; refetch(repository: string, number: number): Promise<void>; start(): void; stop(): void }

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const describe = (r: SyncReport): string => `200=${r.requests[200]} 304=${r.requests[304]} remaining=${r.quota?.remaining ?? '-'}`;

/** The daemon's read sync (#765): the network fills the read model in the background, and the views learn of a change by the event. */
export function createReadModelLoop(deps: ReadModelLoopDeps): ReadModelLoop {
  const sync: SyncDeps = { db: deps.db, rest: deps.rest, source: deps.source, now: deps.now ?? (() => new Date()) };
  const reconciled = new Set<string>(); // once per boot, then every RECONCILE_EVERY_MS
  let timer: NodeJS.Timeout | undefined;
  let running = false; // a slow round never overlaps the next tick
  const refetchedAt = new Map<string, number>(); // by repository#number: when its last refetch started; an unauthenticated GET must not fan out into gh runs
  const refetching = new Set<string>(); // ponytail: refetchedAt only grows, one small entry per issue opened; prune if the spike stays
  const reconcileDue = (repository: string): boolean => {
    const at = deps.db.cursor(scopeOf(deps.source, repository, 'reconcile'))?.syncedAt;
    return !reconciled.has(repository) || at === undefined || sync.now().getTime() - Date.parse(at) >= RECONCILE_EVERY_MS;
  };
  async function syncOne(repository: string): Promise<void> {
    const due = reconcileDue(repository);
    let changed = false;
    try {
      const report = await syncRepository(sync, repository, due, () => { changed = true; });
      if (due) reconciled.add(repository);
      deps.log.debug(`read model: ${repository} ${describe(report)}`);
    } catch (err) {
      deps.log.error(`read model: the sync of ${repository} failed: ${reasonOf(err)}`);
    }
    if (changed) deps.notify(deps.source, repository);
  }
  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const repository of await deps.repositories()) await syncOne(repository);
    } catch (err) {
      deps.log.error(`read model: listing the repositories failed: ${reasonOf(err)}`);
    } finally {
      running = false;
    }
  }
  return {
    runOnce,
    refetch: async (repository, number) => {
      const key = `${repository}#${number}`;
      const at = sync.now().getTime();
      if (refetching.has(key) || at - (refetchedAt.get(key) ?? -Infinity) < REFETCH_COOLDOWN_MS) return;
      refetching.add(key);
      refetchedAt.set(key, at);
      try {
        if (await refetchIssue(sync, repository, number)) deps.notify(deps.source, repository);
      } catch (err) {
        deps.log.error(`read model: the refetch of ${key} failed: ${reasonOf(err)}`);
      } finally {
        refetching.delete(key);
      }
    },
    start: () => {
      void runOnce();
      timer = setInterval(() => void runOnce(), READ_SYNC_INTERVAL_MS);
    },
    stop: () => { if (timer) clearInterval(timer); },
  };
}
