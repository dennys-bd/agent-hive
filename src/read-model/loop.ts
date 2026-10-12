import type { Logger } from '../log.js';
import { POLL_INTERVAL_MS, QUOTA_RESERVE } from '../polling.js';
import type { ReadAccess } from './access.js';
import type { ReadModel, SyncKind } from './db.js';
import { reconcile, refetchIssue, stampReconcile, type RefetchDeps } from './reconcile.js';
import { syncLabels, syncRepo } from './repo-scopes.js';
import type { RestGet, RestQuota } from './rest.js';
import { EMPTY_REPORT, mergeReports, PartialSyncError, SyncStopped, syncScope, type SyncDeps, type SyncReport } from './sync.js';

export const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000; // the full listing's spacing (#180): every page of it is a 200, so once a day bounds its cost
export const REFETCH_COOLDOWN_MS = 10_000; // an issue page opened again within it reads the model, not GitHub

/** What a refetch did (#180): 2.2's issue page waits for it, so the caller needs the outcome. */
export type RefetchOutcome = 'changed' | 'unchanged' | 'gone' | 'failed' | 'skipped';

/** A repository's round: what it stored, and the error that ended it early, if one did. */
export interface RoundResult { report: SyncReport; error?: unknown; commentsBlocked?: true }

/** The readModel frame of /events (#180): a named event as review's, so no State reader takes it for one; the kinds let a view reload only for its own. */
export const readModelEvent = (repository: string, kinds: SyncKind[]): string =>
  `event: readModel\ndata: ${JSON.stringify({ type: 'readModel', repository, kinds })}\n\n`;

// An absent or unreadable stamp is due: NaN fails the <=
function reconcileDue(deps: SyncDeps, repository: string): boolean {
  const at = deps.db.scope(deps.source, repository, 'reconcile')?.syncedAt;
  return !(deps.now().getTime() - Date.parse(at ?? '') <= RECONCILE_EVERY_MS);
}

/** One repository's round (#180): issues, then comments (whose issues the first scope stored), then the repo and labels scopes, then the full listing when due. A first round
 * that read both scopes from null to their end already read everything: it counts as the listing. A scope that throws ends the round
 * there, keeping what the earlier one stored; its own place was never written. REST only: a round never calls GraphQL. */
export async function syncRepository(deps: SyncDeps, repository: string): Promise<RoundResult> {
  let report = EMPTY_REPORT;
  let commentsBlocked = false;
  try {
    const issues = await syncScope(deps, repository, 'issues');
    report = mergeReports(report, issues);
    const comments = await syncScope(deps, repository, 'comments');
    report = mergeReports(report, comments);
    commentsBlocked = comments.blocked === true;
    // #181: after the issue scopes, which the views need most; a failure here ends the round as any scope's does
    report = mergeReports(report, await syncRepo(deps, repository));
    report = mergeReports(report, await syncLabels(deps, repository));
    if (issues.full && comments.full) stampReconcile(deps, repository);
    else if (reconcileDue(deps, repository)) report = mergeReports(report, await reconcile(deps, repository));
    return { report, ...(commentsBlocked ? { commentsBlocked: true as const } : {}) };
  } catch (caught) {
    const partial = caught instanceof PartialSyncError;
    if (partial) report = mergeReports(report, caught.report);
    const error = partial ? caught.original : caught;
    return { report, ...(error instanceof SyncStopped ? {} : { error }) }; // a stop is not a failure
  }
}

export interface ReadModelLoopDeps {
  db: ReadModel;
  access(): Promise<ReadAccess | undefined>; // the login auth.github names now, and its transports; none without a login
  repositories(): Promise<string[]>; // what listRepositories lists now; none before a config
  notify(repository: string, kinds: SyncKind[]): void; // the readModel event
  log: Pick<Logger, 'error' | 'warn' | 'debug'>;
  now?: () => Date;
}

export interface ReadModelLoop {
  runOnce(): Promise<void>;
  refetch(repository: string, number: number): Promise<RefetchOutcome>;
  start(): void;
  stop(): Promise<void>; // resolves once the running round and every refetch in flight settled
}

interface LoopCore { now(): Date; access(): Promise<RefetchDeps | undefined>; inBackoff(): boolean }

const NO_LOGIN = 'read model: no GitHub login for auth.github: nothing syncs until there is one';
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// What a round and a refetch share: the access read per use (a Settings change or a new login takes the next one), the last quota reading
// of any answer, and the REST backoff it drives
function coreOf(deps: ReadModelLoopDeps): LoopCore {
  const now = deps.now ?? ((): Date => new Date());
  let quota: RestQuota | undefined;
  let warned = false;
  const keeping = (rest: RestGet): RestGet => async (path, etag) => {
    const answer = await rest(path, etag);
    quota = answer.quota ?? quota;
    return answer;
  };
  return {
    now,
    access: async () => {
      const access = await deps.access();
      if (access === undefined) {
        if (!warned) deps.log.error(NO_LOGIN); // once, until a login is back: a round every 30 s would repeat it
        warned = true;
        return undefined;
      }
      warned = false;
      return { db: deps.db, rest: keeping(access.rest), gql: access.gql, source: access.source, now };
    },
    // As the GraphQL backoff (polling.ts): what is left goes to the workers' own gh calls; the routes answer from the database meanwhile
    inBackoff: () => quota !== undefined && quota.remaining < QUOTA_RESERVE && Date.parse(quota.resetsAt) > now().getTime(),
  };
}

function roundsOf(deps: ReadModelLoopDeps, core: LoopCore, isStopped: () => boolean): { runOnce(): Promise<void>; running(): Promise<void> | undefined } {
  let round: Promise<void> | undefined;
  async function syncOne(sync: SyncDeps, repository: string): Promise<void> {
    const { report, error, commentsBlocked } = await syncRepository({ ...sync, isStopped }, repository);
    deps.log.debug(`read model: ${repository} 200=${report.requests[200]} 304=${report.requests[304]} kinds=${report.kinds.join(',') || '-'}`);
    if (commentsBlocked === true) deps.log.debug(`read model: the comments of ${repository} wait for an issue not stored yet`); // a wedged scope shows here
    if (error !== undefined) deps.log.error(`read model: the sync of ${repository} failed: ${reasonOf(error)}`);
    if (report.kinds.length > 0) deps.notify(repository, report.kinds); // a partial round too: what it stored is in the model
  }
  async function runRound(): Promise<void> {
    try {
      const repositories = await deps.repositories();
      if (repositories.length === 0) return; // before a config, or none on GitHub: no login read, no request
      const sync = await core.access();
      if (sync === undefined) return;
      for (const repository of repositories) {
        if (isStopped() || core.inBackoff()) return;
        await syncOne(sync, repository);
      }
    } catch (err) {
      deps.log.error(`read model: the round failed: ${reasonOf(err)}`);
    }
  }
  return {
    running: () => round,
    runOnce: () => {
      if (isStopped() || round !== undefined || core.inBackoff()) return Promise.resolve(); // a round still running makes this tick a no-op
      round = runRound().finally(() => {
        round = undefined;
      });
      return round;
    },
  };
}

// One refetch per issue in flight, its promise shared; a REFETCH_COOLDOWN_MS cooldown from its last start, so reopening a page reads the model
function refetchesOf(deps: ReadModelLoopDeps, core: LoopCore, isStopped: () => boolean): { refetch: ReadModelLoop['refetch']; inFlight(): Promise<RefetchOutcome>[] } {
  const inFlight = new Map<string, Promise<RefetchOutcome>>();
  const started = new Map<string, number>();
  async function run(repository: string, number: number): Promise<RefetchOutcome> {
    try {
      const access = await core.access();
      if (access === undefined) return 'skipped';
      const { outcome, kinds, linksError } = await refetchIssue(access, repository, number);
      if (linksError !== undefined) deps.log.warn(`read model: the closing PRs of ${repository}#${number} were not read: ${linksError}`);
      if (kinds.length > 0) deps.notify(repository, kinds); // changed or gone, and only what changed
      return outcome;
    } catch (err) {
      deps.log.error(`read model: the refetch of ${repository}#${number} failed: ${reasonOf(err)}`);
      return 'failed';
    }
  }
  return {
    inFlight: () => [...inFlight.values()],
    refetch: (repository, number) => {
      const key = `${repository}#${number}`;
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const at = core.now().getTime();
      for (const [other, start] of started) if (at - start >= REFETCH_COOLDOWN_MS) started.delete(other); // pruned on each call: the map holds only the last 10 s
      if (isStopped() || core.inBackoff() || started.has(key)) return Promise.resolve('skipped');
      started.set(key, at);
      const promise = run(repository, number).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
  };
}

/** The daemon's read sync (#180): the network fills the read model in the background, one round every POLL_INTERVAL_MS, apart from the
 * Project poll and its GraphQL backoff; the views learn of a change by the readModel event. */
export function createReadModelLoop(deps: ReadModelLoopDeps): ReadModelLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const isStopped = (): boolean => stopped;
  const core = coreOf(deps);
  const rounds = roundsOf(deps, core, isStopped);
  const refetches = refetchesOf(deps, core, isStopped);
  return {
    runOnce: rounds.runOnce,
    refetch: refetches.refetch,
    start: () => {
      void rounds.runOnce();
      timer = setInterval(() => void rounds.runOnce(), POLL_INTERVAL_MS);
    },
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      // the database closes after this: never under a transaction a round or a refetch still holds
      await Promise.allSettled([rounds.running(), ...refetches.inFlight()]);
    },
  };
}
