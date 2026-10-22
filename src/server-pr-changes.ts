// The PR page's changes (#497): what GitHub alone holds of a PR (its diff, its review threads, the compare and the review-request times), read
// beside the fields the model answers and kept in pull_changes per open PR
import { DIFF_MAX_BYTES, DiffTooLarge, parseDiff, withHash } from './diff.js';
import type { Logger } from './log.js';
import { parseThreads, PR_THREADS_QUERY, prDiffArgs, PrNotFound, requestTimesOf, timelineArgs, withRequestTimes } from './pr-github.js';
import { dropStalePrMarks, type PrReviewStore } from './pr-review-store.js';
import { prNumber, prRepo } from './pull-requests.js';
import { type PrPage, type PullChangesRow, sourceLogin } from './read-model/rows.js';
import { prDataOf, type StoredPr } from './read-model/views.js';
import type { Reading } from './server-repos.js';
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

export interface ChangesReader { read(reading: Reading, url: string, fresh: boolean): Promise<{ changes: PrChanges; isLatest(): boolean }> }

/** GET …/pulls/:number/changes' reads (#497). Only the latest read of a PR drops marks: an older one finishing late would drop a mark made
 * against a newer diff. ponytail: one entry per link, never pruned */
export function changesReaderOf(deps: ChangesDeps): ChangesReader {
  const latest = new Map<string, number>();
  return {
    read: async (reading, url) => {
      const mine = (latest.get(url) ?? 0) + 1;
      latest.set(url, mine);
      const { stored, row } = await readFresh(deps, reading, url);
      reading.model.db.setPrChanges(reading.source, prRepo(url), Number(prNumber(url)), row); // the table takes only an open PR's
      return { changes: changesOf(stored, row), isLatest: () => latest.get(url) === mine };
    },
  };
}
