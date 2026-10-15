import type { Correlation, RecordInput } from './events.js';
import type { ActivityRecord, PrState, SliceDelivery, TaskPr } from './types.js';

export const PR_STATES: readonly PrState[] = ['open', 'merged', 'closed'];

// GraphQL's PullRequestState → the task's (#207). A draft PR is OPEN too, so it counts as open.
const GRAPHQL_STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** The open ones of a task's PRs, oldest first (#207): what the tile links and what keeps a worker in review. */
export const openPrs = (prs: TaskPr[] | undefined): TaskPr[] => (prs ?? []).filter((pr) => pr.state === 'open');

/** In review means at least one open PR (#207). */
export const hasOpenPr = (prs: TaskPr[] | undefined): boolean => openPrs(prs).length > 0;

/** Every open PR link across the records, each once (#207, #629): what the poll asks GitHub about. */
export const openPrUrls = (records: ActivityRecord[]): string[] => [...new Set(records.flatMap((r) => openPrs(r.prs).map((pr) => pr.url)))];

/** Every PR of the task merged (#304): at least one across its records, and none open or closed without merge. A wait for CI with no open PR
 * left passes on it; a dropped PR is not a delivery, so it keeps the wait. */
export const mergedOnly = (records: ActivityRecord[]): boolean => {
  const prs = records.flatMap((r) => r.prs ?? []);
  return prs.length > 0 && prs.every((pr) => pr.state === 'merged');
};

/** What the PR activity query asks per link (#742), apart from the state query so a failure here never costs a merge: the PR's creation, its
 * commit count, the last commits' dates (what after_open counts against createdAt) and its head commit's check runs. checkType ALL reads every
 * attempt, not only the latest: a re-run that passed after a failure is how a flaky check shows; last, so many re-runs keep the newest. */
export const ACTIVITY_FIELDS = 'createdAt commits { totalCount } recent: commits(last: 100) { nodes { commit { oid committedDate } } } '
  + 'headCommit: commits(last: 1) { nodes { commit { oid checkSuites(first: 20) { nodes { checkRuns(last: 50, filterBy: { checkType: ALL }) { nodes { databaseId name conclusion startedAt completedAt } } } } } } }';
const STATE_FIELDS = 'state createdAt mergedAt closedAt'; // #742: the times ride along at no extra cost
const SHA_CHARS = 8;

// One aliased resource(url:) per link, p0…pN in order (#207); undefined for none: no open PR, no call. markPr's callers only ever pass a
// GitHub pull request link, and JSON.stringify still makes each one a valid GraphQL string; ci-checks.ts reuses it (#834)
export const aliasedQuery = (urls: string[], fields: string): string | undefined =>
  (urls.length === 0 ? undefined : `query { ${urls.map((url, i) => `p${i}: resource(url: ${JSON.stringify(url)}) { ... on PullRequest { ${fields} } }`).join(' ')} }`);

/** Each open PR's state and times (#207, #742). */
export const prStatesQuery = (urls: string[]): string | undefined => aliasedQuery(urls, STATE_FIELDS);
/** Each open PR's commits and check runs (#742). */
export const prActivityQuery = (urls: string[]): string | undefined => aliasedQuery(urls, ACTIVITY_FIELDS);

export type Alias = Record<string, unknown>;
/** Alias p<i> of an aliasedQuery's answer, or undefined for a null or missing one (#207); ci-checks.ts reuses it (#834). */
export const aliasOf = (data: unknown, i: number): Alias | undefined => {
  const answer = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[`p${i}`] : undefined;
  return typeof answer === 'object' && answer !== null ? (answer as Alias) : undefined;
};
const aliasState = (alias: Alias): PrState | undefined =>
  (typeof alias.state === 'string' && Object.hasOwn(GRAPHQL_STATES, alias.state) ? GRAPHQL_STATES[alias.state] : undefined);
const dateOf = (value: unknown): string | undefined => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined);

// The PR's own times (#742), as GitHub answers them; a missing or odd one is left out
function prTimes(alias: Alias): Pick<TaskPr, 'openedAt' | 'mergedAt' | 'closedAt'> {
  const [openedAt, mergedAt, closedAt] = [dateOf(alias.createdAt), dateOf(alias.mergedAt), dateOf(alias.closedAt)];
  return { ...(openedAt ? { openedAt } : {}), ...(mergedAt ? { mergedAt } : {}), ...(closedAt ? { closedAt } : {}) };
}

/** The states the answer holds, alias p<i> for urls[i] (#207), with the PR's times (#742). A null alias (a deleted repository, a lost
 * permission), a missing one or any other shape is left out: that PR keeps the state it had, since none of those is evidence of a merge. */
export function parsePrStates(urls: string[], data: unknown): TaskPr[] {
  return urls.flatMap((url, i) => {
    const alias = aliasOf(data, i);
    const state = alias === undefined ? undefined : aliasState(alias);
    return alias === undefined || state === undefined ? [] : [{ url, state, ...prTimes(alias) }];
  });
}

/** A concluded check run on a PR's head commit (#742): its id, its raw name, its conclusion, the commit's sha (8 chars) and how long it ran. */
export interface CheckRunRead { id: number; name: string; conclusion: string; sha: string; durationMs?: number }
/** What the PR query read for the event log beyond the state (#742). */
// afterOpen: the commits GitHub dates after the PR's creation, so it holds across restarts
// recent: the last commits read, each as its sha (8 chars) and GitHub's committedDate: what pr.commit writes once per commit
export interface CommitRead { sha: string; committedAt: string }
export interface PrActivity { url: string; commits?: number; afterOpen?: number; recent: CommitRead[]; checks: CheckRunRead[] }

const nodesOf = (value: unknown): unknown[] => {
  const nodes = typeof value === 'object' && value !== null ? (value as { nodes?: unknown }).nodes : undefined;
  return Array.isArray(nodes) ? nodes : [];
};

// The head commit's concluded check runs; a run still going, or any odd node, is left out
function checksOf(alias: Alias): CheckRunRead[] {
  const head = nodesOf(alias.headCommit)[0] as { commit?: { oid?: unknown; checkSuites?: unknown } } | null | undefined;
  const commit = head?.commit;
  if (typeof commit?.oid !== 'string') return [];
  const sha = commit.oid.slice(0, SHA_CHARS);
  return nodesOf(commit.checkSuites).flatMap((suite) => nodesOf((suite as { checkRuns?: unknown } | null)?.checkRuns)).flatMap((node) => {
    const run = (node ?? {}) as { databaseId?: unknown; name?: unknown; conclusion?: unknown; startedAt?: unknown; completedAt?: unknown };
    if (typeof run.databaseId !== 'number' || typeof run.name !== 'string' || typeof run.conclusion !== 'string') return [];
    const ms = Date.parse(String(run.completedAt)) - Date.parse(String(run.startedAt));
    return [{ id: run.databaseId, name: run.name, conclusion: run.conclusion.toLowerCase(), sha, ...(Number.isFinite(ms) ? { durationMs: ms } : {}) }];
  });
}

// The commits dated after the PR opened, among the last 100 read; undefined without a creation time.
// ponytail: past 100 commits on one PR the oldest are not read; a second page if a PR ever carries that many
function afterOpen(alias: Alias): number | undefined {
  const opened = Date.parse(String(alias.createdAt));
  if (!Number.isFinite(opened)) return undefined;
  return nodesOf(alias.recent).filter((node) => Date.parse(String((node as { commit?: { committedDate?: unknown } } | null)?.commit?.committedDate)) > opened).length;
}

// The last commits read with a sha and a date; an odd node is left out
function recentOf(alias: Alias): CommitRead[] {
  return nodesOf(alias.recent).flatMap((node) => {
    const commit = (node as { commit?: { oid?: unknown; committedDate?: unknown } } | null)?.commit;
    const committedAt = dateOf(commit?.committedDate);
    return typeof commit?.oid === 'string' && committedAt !== undefined ? [{ sha: commit.oid.slice(0, SHA_CHARS), committedAt }] : [];
  });
}

/** Each PR's commit count, the commits after it opened and its concluded check runs (#742); a null or missing alias is left out. */
export function parsePrActivity(urls: string[], data: unknown): PrActivity[] {
  return urls.flatMap((url, i) => {
    const alias = aliasOf(data, i);
    if (alias === undefined) return [];
    const total = (alias.commits as { totalCount?: unknown } | null | undefined)?.totalCount;
    const after = afterOpen(alias);
    return [{ url, ...(Number.isInteger(total) ? { commits: total as number } : {}), ...(after === undefined ? {} : { afterOpen: after }), recent: recentOf(alias), checks: checksOf(alias) }];
  });
}

/** What earlier polls already wrote (#742), in memory and per open PR: its check run ids, its commits' shas and its last commit count. A duplicate after a
 * restart is resolved at analysis by check_run_id. */
export type PrSeen = Readonly<Record<string, { checks: readonly number[]; shas: readonly string[]; commits?: number }>>;
export const NO_PR_SEEN: PrSeen = {};

// One PR's read as records: each check run not seen yet, and the commit count when it moved
function readRecords(read: PrActivity, known: PrSeen[string] | undefined, ids: Correlation): { records: RecordInput[]; seen: PrSeen[string] } {
  const pr = Number(prNumber(read.url));
  const fresh = read.checks.filter((run) => !known?.checks.includes(run.id));
  const checks = fresh.map((run): RecordInput => ({
    event: 'pr.checks', level: 'info', ...ids, pr, sha: run.sha, check_run_id: run.id, name: run.name, conclusion: run.conclusion,
    ...(run.durationMs === undefined ? {} : { duration_ms: run.durationMs }),
  }));
  const newCommits = read.recent.filter((c) => !known?.shas.includes(c.sha));
  const commit = newCommits.map((c): RecordInput => ({ event: 'pr.commit', level: 'info', ...ids, pr, sha: c.sha, committed_at: c.committedAt }));
  const count = read.commits ?? known?.commits;
  const commits: RecordInput[] = read.commits === undefined || read.commits === known?.commits ? []
    : [{ event: 'pr.commits', level: 'info', ...ids, pr, count: read.commits, ...(read.afterOpen === undefined ? {} : { after_open: read.afterOpen }) }];
  const shas = [...(known?.shas ?? []), ...newCommits.map((c) => c.sha)];
  return { records: [...checks, ...commit, ...commits], seen: { checks: [...(known?.checks ?? []), ...fresh.map((run) => run.id)], shas, ...(count === undefined ? {} : { commits: count }) } };
}

/** The poll's PR reads as records (#742): each concluded check run once by id, the commit count each time it changes. What is kept is pruned
 * to `open`, the PRs still open. Pure: the next `seen` is returned, the given one is never touched. */
export function prActivityRecords(reads: PrActivity[], seen: PrSeen, correlate: (url: string) => Correlation, open: readonly string[]): { records: RecordInput[]; seen: PrSeen } {
  const kept: Record<string, PrSeen[string]> = Object.fromEntries(Object.entries(seen).filter(([url]) => open.includes(url)));
  const records = reads.flatMap((read) => {
    const result = readRecords(read, kept[read.url], correlate(read.url));
    if (open.includes(read.url)) kept[read.url] = result.seen;
    return result.records;
  });
  return { records, seen: kept };
}

const TIMES = ['openedAt', 'mergedAt', 'closedAt'] as const;
const unchanged = (pr: TaskPr, read: TaskPr): boolean => pr.state === read.state && TIMES.every((key) => read[key] === undefined || read[key] === pr[key]);

/** The records after a PR query (#207, #629): each listed link takes the state and the times read (#742). A record, or a PR, with nothing new
 * is the same object. */
export function withPrStates(records: ActivityRecord[], states: TaskPr[]): ActivityRecord[] {
  const read = new Map(states.map((s) => [s.url, s]));
  return records.map((record) => {
    const prs = record.prs?.map((pr) => {
      const next = read.get(pr.url);
      return next === undefined || unchanged(pr, next) ? pr : { ...pr, ...next };
    });
    return prs === undefined || prs.every((pr, i) => pr === record.prs?.[i]) ? record : { ...record, prs };
  });
}

/** The PR's number, read off its link on display (#207), never stored: the link already holds it. The whole link if it has none. */
export const prNumber = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? url;

/** A PR's line in its group (#698), derived on display: its slice's place among the group's slices, and the PR it targets when that is a PR. */
export interface PrLine { pr: TaskPr; position?: { k: number; total: number }; base?: string }

/** The task's PRs of one repository (#698), in merge order: type is its slices' delivery mode (mixed: the last reported); merged and slices
 * count its slices only; own marks the task's repository. */
export interface PrGroup { repo: string; type?: SliceDelivery; lines: PrLine[]; merged: number; slices: number; own: boolean }

/** owner/name off a PR link (#698): never sent, the link already holds it. */
export const prRepo = (url: string): string => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? url;

/** A PR's link from its repository and number (#758): what the routes name a PR by, and the review file's key. */
export const prLink = (repository: string, number: number): string => `https://github.com/${repository}/pull/${number}`;

/** The repository's name without its owner (#698): what the details panel, the flow line and the picker show. */
export const repoName = (repo: string): string => repo.split('/').at(-1) ?? repo;

// Each link once, in the place it first arrived, with its latest entry (#698): a link reported again lands in the newest record
const latest = (prs: TaskPr[]): TaskPr[] => [...new Map(prs.map((pr) => [pr.url, pr])).values()];

// k is the merge order; a PR without a slice comes after the slices, by number, the opening order (a reopened slice keeps its k)
const sliceK = (pr: TaskPr): number => pr.slice?.k ?? Number.MAX_SAFE_INTEGER;
const byMergeOrder = (a: TaskPr, b: TaskPr): number => sliceK(a) - sliceK(b) || Number(prNumber(a.url)) - Number(prNumber(b.url));

// What slice i targets, never fetched (#698): in stacked the previous slice's PR, slice 1 the base; in integration every slice the
// integration PR (the last one), which itself targets the base
function baseOf(sliced: TaskPr[], i: number, type: SliceDelivery): string | undefined {
  if (type === 'stacked') return sliced[i - 1]?.url;
  return i === sliced.length - 1 ? undefined : sliced.at(-1)?.url;
}

function groupOf(repo: string, prs: TaskPr[], own: boolean): PrGroup {
  const ordered = [...prs].sort(byMergeOrder);
  const sliced = ordered.filter((pr) => pr.slice !== undefined); // first in ordered, so a slice's index is the same in both
  const type = prs.filter((pr) => pr.slice !== undefined).at(-1)?.slice?.type;
  const lines = ordered.map((pr, i): PrLine => {
    if (pr.slice === undefined || type === undefined) return { pr };
    const base = baseOf(sliced, i, type);
    return { pr, position: { k: pr.slice.k, total: sliced.length }, ...(base === undefined ? {} : { base }) };
  });
  const merged = sliced.filter((pr) => pr.state === 'merged').length;
  return { repo, ...(type === undefined ? {} : { type }), lines, merged, slices: sliced.length, own };
}

/** The task's PRs by repository (#698): its own first (ownRepo when a PR is there, else the first PR's), then the others in the order their
 * first PR arrived. prs is oldest first, across records. */
export function prGroups(prs: TaskPr[], ownRepo?: string): PrGroup[] {
  const unique = latest(prs);
  const repos = [...new Set(unique.map((pr) => prRepo(pr.url)))];
  const own = ownRepo !== undefined && repos.includes(ownRepo) ? ownRepo : repos[0];
  return [...repos.filter((r) => r === own), ...repos.filter((r) => r !== own)]
    .map((repo) => groupOf(repo, unique.filter((pr) => prRepo(pr.url) === repo), repo === own));
}

/** What show PR opens (#592, #698): the own repository's first open PR in merge order; with none open there, the task's newest. */
export const nextPr = (prs: TaskPr[], ownRepo?: string): string | undefined =>
  prGroups(prs, ownRepo)[0]?.lines.find((line) => line.pr.state === 'open')?.pr.url ?? prs.at(-1)?.url;

/** The first open slice before `url` in its group (#698), which must merge first; undefined for a PR without a slice. */
export function mergeOrderBlocker(prs: TaskPr[], url: string): string | undefined {
  const lines = prGroups(prs).find((group) => group.lines.some((line) => line.pr.url === url))?.lines ?? [];
  const at = lines.findIndex((line) => line.pr.url === url);
  if (lines[at]?.position === undefined) return undefined;
  return lines.slice(0, at).find((line) => line.pr.state === 'open')?.pr.url;
}
