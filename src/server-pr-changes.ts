// The PR page's changes (#497): what GitHub alone holds of a PR (its diff, its review threads, the compare and the review-request times), read
// beside the fields the model answers and kept in pull_changes per open PR
import { DIFF_MAX_BYTES, DiffTooLarge, parseDiff, withHash } from './diff.js';
import type { Logger } from './log.js';
import { parseThreads, PR_THREADS_QUERY, prDiffArgs, PrNotFound, requestTimesOf, timelineArgs, withRequestTimes } from './pr-github.js';
import { dropStalePrMarks, type PrReviewStore } from './pr-review-store.js';
import { prLink, prNumber, prRepo } from './pull-requests.js';
import { REFETCH_COOLDOWN_MS } from './read-model/loop.js';
import { type PrPage, type PullChangesRow, sourceLogin } from './read-model/rows.js';
import { prDataOf, type StoredPr } from './read-model/views.js';
import type { Reading, RepoReadModel } from './server-repos.js';
import type { Exec as GhExec } from './sources/github-gql.js';
import type { FileDiff, Gql, PrChanges } from './types.js';

/** What the changes' reads need (#497); PrRouteDeps carries all of it. */
export interface ChangesDeps { gql: Gql; gh: GhExec; log: Pick<Logger, 'debug' | 'error'>; prReviews: Pick<PrReviewStore, 'read' | 'update'>; notifyPrReview(url: string): void }

/** A head that moved twice while the changes were read (#592): the route's 409. */
export class HeadMoved extends Error {
  constructor() {
    super('the head moved while the PR was read');
    this.name = 'HeadMoved';
  }
}

// #270's cap, checked before a diff is answered or stored. ponytail: gh's own 20 MB buffer answers a larger one with its overflow, a 502
function capped(diff: string): string {
  if (Buffer.byteLength(diff, 'utf8') > DIFF_MAX_BYTES) throw new DiffTooLarge();
  return diff;
}
const filesOf = (diff: string): FileDiff[] => parseDiff(diff).map(withHash);
// An error's class only: its message may carry gh's output, and the log line names the PR by number
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
const skipOf = (deps: ChangesDeps, url: string) => (reason: string): void => deps.log.debug(`pr #${prNumber(url)}: an item skipped (${reason})`);

// How far the base moved past the head (#854, #187): REST's compare, for every open PR. A deleted fork has no
// head to compare; a failure is no number
async function behindOf(deps: ChangesDeps, url: string, data: StoredPr): Promise<{ behindBy?: number }> {
  if (data.state !== 'open' || data.headOwner === '') return {};
  try {
    const compare = JSON.parse(await deps.gh(['api', `repos/${prRepo(url)}/compare/${encodeURIComponent(data.baseRef)}...${encodeURIComponent(data.headOwner)}:${encodeURIComponent(data.headRef)}`])) as { behind_by?: unknown };
    return typeof compare.behind_by === 'number' ? { behindBy: compare.behind_by } : {};
  } catch (err) {
    deps.log.debug(`pr #${prNumber(url)}: the compare was not read (${errorName(err)})`);
    return {};
  }
}

// The review-request times (#67, #187): the timeline, read only when a request is pending; a failure only drops the times
async function timesOf(deps: ChangesDeps, url: string, data: StoredPr): Promise<PullChangesRow['requestTimes']> {
  if (data.reviewRequests.length === 0) return [];
  try {
    return requestTimesOf(await deps.gh(timelineArgs(prRepo(url), Number(prNumber(url)))));
  } catch (err) {
    deps.log.debug(`pr #${prNumber(url)}: the timeline was not read (${errorName(err)})`);
    return [];
  }
}

// The marks whose file changed or left the diff go once the answer is out (#592), broadcast only when some went; a fixed log line, since a
// JSON error of the file quotes its content
export async function dropStale(deps: ChangesDeps, url: string, files: FileDiff[]): Promise<void> {
  try {
    const current = await deps.prReviews.read(url);
    if (dropStalePrMarks(current, files) === current) return;
    await deps.prReviews.update(url, (file) => dropStalePrMarks(file, files));
    deps.notifyPrReview(url);
  } catch (err) {
    deps.log.error(`pr review #${prNumber(url)}: the stale marks could not be dropped (${err instanceof Error ? err.name : 'error'})`);
  }
}

// The four reads (#497), in parallel: the diff, the threads with the head they were read at, the compare and the times
async function readAll(deps: ChangesDeps, url: string, stored: StoredPr): Promise<PullChangesRow> {
  const [diff, threads, behind, requestTimes] = await Promise.all([
    deps.gh(prDiffArgs(url)), deps.gql(PR_THREADS_QUERY, { url }), behindOf(deps, url, stored), timesOf(deps, url, stored),
  ]);
  const read = parseThreads(threads, skipOf(deps, url));
  return { head: read.head, diff: capped(diff), threads: read.threads, truncated: read.truncated, ...behind, requestTimes };
}

// The PR's page. One the model lacks waits for the refetch, the same promise the fields' read awaits; none after it is PrNotFound
async function pageOf(reading: Reading, repository: string, number: number): Promise<PrPage> {
  const page = reading.model.db.prPage(reading.source, repository, number);
  if (page !== undefined) return page;
  await reading.model.refetch(repository, number);
  const late = reading.model.db.prPage(reading.source, repository, number);
  if (late === undefined) throw new PrNotFound();
  return late;
}

/** No row at the model's head (#497): the four reads. The diff carries no oid, so a threads head other than the model's is refetched and read
 * once more, and a second move is HeadMoved. The exception is a refetch that did not read GitHub: then the answer is at the threads' head, which
 * is the diff's own (#187). */
export async function readFresh(deps: ChangesDeps, reading: Reading, url: string): Promise<{ stored: StoredPr; row: PullChangesRow }> {
  const repository = prRepo(url);
  const number = Number(prNumber(url)); // the text of a link a route checked: digits
  for (const again of [false, true]) {
    const outcome = again ? await reading.model.refetch(repository, number, { again }) : undefined;
    const page = await pageOf(reading, repository, number);
    const stored = prDataOf(page, sourceLogin(reading.source));
    const row = await readAll(deps, url, stored);
    const head = page.pull?.headSha ?? row.head; // never polled: the threads' head is all there is
    const refetched = outcome !== 'failed' && outcome !== 'skipped';
    if (row.head !== head && (!again || refetched)) continue;
    return { stored, row };
  }
  throw new HeadMoved();
}

/** A row as the route answers it (#497): the diff parsed with its hashes, the model's pending requests with the times the row read. */
export function changesOf(stored: Pick<StoredPr, 'reviewRequests'>, row: PullChangesRow): PrChanges {
  return {
    head: row.head, files: filesOf(row.diff), threads: row.threads, truncated: row.truncated,
    ...(row.behindBy === undefined ? {} : { behindBy: row.behindBy }), reviewRequests: withRequestTimes(stored.reviewRequests, row.requestTimes),
  };
}

export interface ChangesReader {
  read(reading: Reading, url: string, fresh: boolean): Promise<{ changes: PrChanges; isLatest(): boolean }>;
  preload(reading: Reading, url: string): Promise<void>; // #497: the full read, stored; the route's own read when one is in flight
}

/** What the preload needs beyond the reader (#497): the model (absent: setup mode or a failed open), whether the Hive lists a repository, the log. */
export interface PreloadDeps { readModel?: RepoReadModel; isListed(repository: string): Promise<boolean>; log: Pick<Logger, 'debug'> }

// A moved head's diff (#497): the model refetched first, so the next fields read names the head the diff was read at
async function movedDiff(deps: ChangesDeps, reading: Reading, url: string): Promise<string> {
  await reading.model.refetch(prRepo(url), Number(prNumber(url)), { again: true });
  return capped(await deps.gh(prDiffArgs(url)));
}

// The revalidation (#497): the threads, the compare and the times in parallel, since threads change without the head moving. The diff is read
// only when the threads' head left the row's, as the diff carries no oid. A changed row sends the pullChanges event, and a new diff drops the
// stale marks unless a read began since. A failure is a debug line by number and leaves the row
async function revalidate(deps: ChangesDeps, reading: Reading, url: string, latestOf: (url: string) => number): Promise<void> {
  const seen = latestOf(url);
  const repository = prRepo(url);
  const number = Number(prNumber(url));
  try {
    const page = reading.model.db.prPage(reading.source, repository, number);
    const kept = reading.model.db.prChanges(reading.source, repository, number);
    if (page === undefined || kept === undefined) return; // closed or gone since the answer
    const stored = prDataOf(page, sourceLogin(reading.source));
    const [threads, behind, requestTimes] = await Promise.all([deps.gql(PR_THREADS_QUERY, { url }), behindOf(deps, url, stored), timesOf(deps, url, stored)]);
    const read = parseThreads(threads, skipOf(deps, url));
    const diff = read.head === kept.head ? kept.diff : await movedDiff(deps, reading, url);
    const row: PullChangesRow = { head: read.head, diff, threads: read.threads, truncated: read.truncated, ...behind, requestTimes };
    if (!reading.model.db.setPrChanges(reading.source, repository, number, row)) return;
    reading.model.notify(repository, ['pullChanges']);
    if (diff !== kept.diff && latestOf(url) === seen) await dropStale(deps, url, filesOf(diff));
  } catch (err) {
    deps.log.debug(`pr #${number}: the changes were not revalidated (${errorName(err)})`);
  }
}

interface Revalidations { start(reading: Reading, url: string, fresh: boolean): Promise<void>; stamp(url: string): void }

// One revalidation per PR in flight, its promise shared, and REFETCH_COOLDOWN_MS from its last start, as the refetch's: reopening a page within
// it makes no GitHub call. fresh goes past the cooldown, as the refetch's `again`
function revalidationsOf(deps: ChangesDeps, now: () => number, latestOf: (url: string) => number): Revalidations {
  const inFlight = new Map<string, Promise<void>>();
  const started = new Map<string, number>();
  const stamp = (url: string): void => {
    const at = now();
    for (const [other, start] of started) if (at - start >= REFETCH_COOLDOWN_MS) started.delete(other); // pruned on each call: only the last 10 s
    started.set(url, at);
  };
  return {
    stamp,
    start: (reading, url, fresh) => {
      const running = inFlight.get(url);
      if (running !== undefined) return running;
      const last = started.get(url);
      if (!fresh && last !== undefined && now() - last < REFETCH_COOLDOWN_MS) return Promise.resolve();
      stamp(url);
      const promise = revalidate(deps, reading, url, latestOf).finally(() => inFlight.delete(url));
      inFlight.set(url, promise);
      return promise;
    },
  };
}

/** GET …/pulls/:number/changes' reads (#497): a row at the model's head answers at once and is revalidated behind the answer; otherwise the full
 * read, stored when the PR is open. Only the latest read of a PR drops marks. ponytail: one entry per link, never pruned */
export function changesReaderOf(deps: ChangesDeps, now: () => number = Date.now): ChangesReader {
  const latest = new Map<string, number>();
  const latestOf = (url: string): number => latest.get(url) ?? 0;
  const revalidations = revalidationsOf(deps, now, latestOf);
  // One full read per PR in flight, shared by the route and hive_pr's preload (#497), so the two never read GitHub twice for one head
  const fulls = new Map<string, Promise<{ stored: StoredPr; row: PullChangesRow }>>();
  const fullRead = (reading: Reading, url: string): Promise<{ stored: StoredPr; row: PullChangesRow }> => {
    const running = fulls.get(url);
    if (running !== undefined) return running;
    revalidations.stamp(url); // a full read counts as the PR's last read for the cooldown
    const promise = readFresh(deps, reading, url).then((read) => {
      reading.model.db.setPrChanges(reading.source, prRepo(url), Number(prNumber(url)), read.row); // the table takes only an open PR's
      return read;
    }).finally(() => fulls.delete(url));
    fulls.set(url, promise);
    return promise;
  };
  return {
    preload: async (reading, url) => { await fullRead(reading, url); },
    read: async (reading, url, fresh) => {
      const mine = latestOf(url) + 1;
      latest.set(url, mine);
      const isLatest = (): boolean => latestOf(url) === mine;
      const repository = prRepo(url);
      const number = Number(prNumber(url));
      const page = await pageOf(reading, repository, number);
      const kept = reading.model.db.prChanges(reading.source, repository, number);
      if (kept !== undefined && kept.head === page.pull?.headSha) {
        void revalidations.start(reading, url, fresh); // never rejects: revalidate logs its own failure
        return { changes: changesOf(prDataOf(page, sourceLogin(reading.source)), kept), isLatest };
      }
      const { stored, row } = await fullRead(reading, url);
      return { changes: changesOf(stored, row), isLatest };
    },
  };
}

/** hive_pr's preload (#497): once per PR, its refetch, then the changes' full read, stored, so a task's PR opens fast the first time. Later heads
 * are read when the page opens. No model, an unlisted repository, no login or a failed read is a debug line by number, and nothing is stored.
 * ponytail: the once-set lives in memory, one entry per PR reported since the start */
export function preloaderOf(deps: PreloadDeps, reader: ChangesReader): (url: string) => Promise<void> {
  const preloaded = new Set<string>();
  return async (reported) => {
    const repository = prRepo(reported);
    const number = Number(prNumber(reported));
    const url = prLink(repository, number); // the route's own key, so the two share their full read
    if (preloaded.has(url)) return;
    preloaded.add(url);
    const skip = (why: string): void => deps.log.debug(`pr #${number}: the changes were not preloaded (${why})`);
    try {
      const model = deps.readModel;
      if (model === undefined) return skip('no read model');
      if (!(await deps.isListed(repository))) return skip('its repository is not listed');
      const source = await model.source();
      if (source === undefined) return skip('no GitHub login');
      await model.refetch(repository, number);
      await reader.preload({ model, source }, url);
    } catch (err) {
      skip(errorName(err));
    }
  };
}
