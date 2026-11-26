// The PR poll's read of open GitLab merge requests (#1052): per MR, one REST call for its state and times, then its commits listing for the
// fact log, each through its host's account. REST, not GraphQL, so any self-hosted version the account accepts answers. A failure costs only
// its own MR, or its host's MRs for a host with no account, and comes back as a line for the caller to log: the host and the MR's number, never a token.
import { type CommitRead, dateOf, type PrActivity } from '../pull-requests.js';
import { type PrLink, parsePrLink } from '../repo-host.js';
import { SourceNotConnectedError, SourceRateLimitError } from '../source-errors.js';
import type { TaskPr } from '../types.js';
import { type GitlabApi, listAll, projectPath } from './api.js';
import { mrState } from './mr-state.js';

const SHA_CHARS = 8; // as the GitHub read's (#742)
const RECENT_MAX = 100; // as GitHub's commits(last: 100): what pr.commit is written from

/** A host's client, or none when the host has no account: gitlabAccess in the server, a fake in tests. */
export type GitlabAccess = (host: string) => Promise<Pick<GitlabApi, 'get'> | undefined>;
/** What a read answers: what it read, and one line per host or MR that failed. */
export interface MrReads<T> { reads: T[]; failures: string[] }

interface Entry { url: string; link: PrLink }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const mrPath = ({ repository, number }: PrLink): string => `projects/${projectPath(repository)}/merge_requests/${number}`;

// The links parsePrLink reads, by host, in the order each host first appears
function byHost(urls: readonly string[]): Map<string, Entry[]> {
  const hosts = new Map<string, Entry[]>();
  for (const url of urls) {
    const link = parsePrLink(url);
    if (link !== undefined) hosts.set(link.host, [...(hosts.get(link.host) ?? []), { url, link }]);
  }
  return hosts;
}

// A rate limit, a refused token or no answer at all (fetch's TypeError, the client's timeout) holds for every MR of the host: reading the
// rest would only spend the limit or wait a timeout each, on every poll. A 404 or an odd answer is that MR's own
const isHostWide = (err: unknown): boolean => err instanceof SourceRateLimitError || err instanceof SourceNotConnectedError
  || (err instanceof Error && ['TypeError', 'TimeoutError', 'AbortError'].includes(err.name));

// Every MR through `read`, one host after the other: a host with no account fails once for all its MRs, a failed MR fails alone, unless
// its failure is the host's
async function eachMr<T>(urls: readonly string[], access: GitlabAccess, read: (api: Pick<GitlabApi, 'get'>, entry: Entry) => Promise<T>): Promise<MrReads<T>> {
  const reads: T[] = [];
  const failures: string[] = [];
  for (const [host, entries] of byHost(urls)) {
    const api = await access(host);
    if (api === undefined) {
      failures.push(`${host}: no account`);
      continue;
    }
    for (const [i, entry] of entries.entries()) {
      try {
        reads.push(await read(api, entry));
      } catch (err) {
        failures.push(`${host} #${entry.link.number}: ${errorMessage(err)}`);
        if (!isHostWide(err)) continue;
        const skipped = entries.slice(i + 1).map((e) => `#${e.link.number}`);
        if (skipped.length > 0) failures.push(`${host}: skipped ${skipped.join(', ')}`);
        break;
      }
    }
  }
  return { reads, failures };
}

// The MR's state and times. An unknown state or an odd answer is no evidence of anything, so the MR keeps the state it had; GitLab's own text
// is never quoted back, since it would reach hive.log
async function stateOf(api: Pick<GitlabApi, 'get'>, { url, link }: Entry): Promise<TaskPr> {
  const { body } = await api.get(mrPath(link));
  if (!isRecord(body) || typeof body.state !== 'string') throw new Error('unexpected answer');
  const state = mrState(body.state);
  if (state === undefined) throw new Error('unknown state');
  const [openedAt, mergedAt, closedAt] = [dateOf(body.created_at), dateOf(body.merged_at), dateOf(body.closed_at)];
  return { url, state, ...(openedAt ? { openedAt } : {}), ...(mergedAt ? { mergedAt } : {}), ...(closedAt ? { closedAt } : {}) };
}

const commitOf = (item: unknown): CommitRead[] => {
  const committedAt = isRecord(item) ? dateOf(item.committed_date) : undefined;
  return isRecord(item) && typeof item.id === 'string' && committedAt !== undefined ? [{ sha: item.id.slice(0, SHA_CHARS), committedAt }] : [];
};

// The MR's commits as the GitHub read gives a PR's (#742): the count, the first RECENT_MAX listed and those of them dated after the MR opened.
// No checks until #790
async function activityOf(api: Pick<GitlabApi, 'get'>, { url, link }: Entry, openedAt: string | undefined): Promise<PrActivity> {
  const listed = await listAll(api, `${mrPath(link)}/commits?per_page=${RECENT_MAX}`);
  const recent = listed.slice(0, RECENT_MAX).flatMap(commitOf);
  const opened = openedAt === undefined ? Number.NaN : Date.parse(openedAt);
  const afterOpen = Number.isFinite(opened) ? recent.filter((c) => Date.parse(c.committedAt) > opened).length : undefined;
  return { url, commits: listed.length, ...(afterOpen === undefined ? {} : { afterOpen }), recent, checks: [] };
}

/** Each MR's state and times (#1052). */
export const readMrStates = (urls: readonly string[], access: GitlabAccess): Promise<MrReads<TaskPr>> => eachMr(urls, access, stateOf);

/** The commits of each MR whose state was read (#1052), measured from that read's creation time. Apart from the state read, so a failure here
 * costs no state. */
export function readMrActivity(states: readonly TaskPr[], access: GitlabAccess): Promise<MrReads<PrActivity>> {
  const opened = new Map(states.map((s) => [s.url, s.openedAt]));
  return eachMr(states.map((s) => s.url), access, (api, entry) => activityOf(api, entry, opened.get(entry.url)));
}
