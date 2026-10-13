import { prLink } from '../pull-requests.js';
import { issueUrl } from '../repos/issue-task.js';
import type { RepoRef } from '../repos/repositories.js';
import type { IssuePage, PrCheck, PrChecks, PrData, PrReviewEvent, PrState, RepoIssue, RepoIssues, RepoPrs, RepoSummary, TaskComment } from '../types.js';
import type { ReadModel } from './db.js';
import { worstOf } from './normalize.js';
import { type CheckRow, type CommentRow, type IssueView, type PrPage, type PullRow, type ReviewRow, sourceLogin } from './rows.js';

/** The issue list's cap (#757, #181): as the native view's; past it the list says truncated. */
export const REPO_ISSUE_LIMIT = 1000;
/** The PR list's cap (#758, #186): the rows past it are counted, not sent, and the list says truncated. */
export const PR_LIST_LIMIT = 100;
const COMMENT_LIMIT = 100; // the page's first comments, oldest first; commentCount says how many there are
const GHOST = 'ghost'; // what GitHub itself shows for a deleted account
const GITHUB = 'https://github.com';

// ISO strings in GitHub's one format sort as the instants they name
const latest = (dates: (string | null | undefined)[]): string | undefined =>
  dates.filter((d): d is string => typeof d === 'string' && d !== '').sort().at(-1);

// Only the list's fields: the row's body and the rest stay off the wire
const repoIssueOf = (issue: IssueView): RepoIssue => ({
  number: issue.number, title: issue.title, url: issueUrl(issue.repository, issue.number), labels: issue.labels, assignees: issue.assignees,
  updatedAt: issue.updatedAt, pullRequests: issue.pullRequests,
});

const commentOf = (comment: CommentRow): TaskComment => ({ author: comment.author ?? GHOST, createdAt: comment.createdAt, body: comment.body, url: comment.url });

/** One sidebar summary (#181): the repos row and the rows' counts. With no repos row, what the Hive already knows, so the sidebar never
 * loses a repository it lists: the ref's fields, its github.com url, no push rights, issues on, syncedAt null. */
export function summaryOf(db: ReadModel, source: string, ref: RepoRef): RepoSummary {
  const row = db.repo(source, ref.repository);
  const counts = db.counts(source, ref.repository);
  const lastActivity = latest([row?.pushedAt, counts.lastUpdatedAt]);
  const parent = row?.forkParent ?? null;
  return {
    repository: ref.repository, url: row?.url ?? `${GITHUB}/${ref.repository}`, workspace: ref.workspace,
    openPrs: counts.openPrs, openIssues: counts.openIssues, closedIssues: counts.closedIssues,
    canPush: row?.canPush ?? false, issuesEnabled: row?.issuesEnabled ?? true, syncedAt: db.scope(source, ref.repository, 'repo')?.syncedAt ?? null,
    ...(lastActivity === undefined ? {} : { lastActivity }), ...(parent === null ? {} : { fork: { parent } }),
    ...(ref.role === undefined ? {} : { role: ref.role }), ...(ref.pr === undefined ? {} : { pr: ref.pr }), ...(ref.pair === undefined ? {} : { pair: ref.pair }),
  };
}

/** A repository's issues in one state (#181), newest update first, up to REPO_ISSUE_LIMIT; total counts every row of that state. */
export function issuesOf(db: ReadModel, source: string, repository: string, state: RepoIssues['state']): RepoIssues {
  const counts = db.counts(source, repository);
  const total = state === 'open' ? counts.openIssues : counts.closedIssues;
  return {
    state, total, issues: db.issues(source, repository, state, REPO_ISSUE_LIMIT).map(repoIssueOf), truncated: total > REPO_ISSUE_LIMIT,
    syncedAt: db.scope(source, repository, 'issues')?.syncedAt ?? null,
  };
}

/** One issue's page (#181), or undefined when the model has no such issue. ponytail: every comment is read to count them; a COUNT when an
 * issue's comments grow large. */
export function issuePageOf(db: ReadModel, source: string, repository: string, number: number): IssuePage | undefined {
  const issue = db.issue(source, repository, number);
  if (issue === undefined) return undefined;
  const comments = db.comments(source, issue.nodeId);
  return {
    ...repoIssueOf(issue), repository, body: issue.body, author: issue.author ?? GHOST, createdAt: issue.createdAt,
    comments: comments.slice(0, COMMENT_LIMIT).map(commentOf), commentCount: comments.length,
  };
}

/** Whose PRs an original lists (#854, #186): the login's, as the search's author:@me did; undefined, every PR, anywhere else. */
export const prAuthorOf = (source: string, ref: RepoRef): string | undefined =>
  (ref.role === 'original' && ref.pair !== undefined ? sourceLogin(source) : undefined);

/** A repository's PRs in one state (#186), from the model alone: newest update first, up to PR_LIST_LIMIT, the counts of every state, canPush
 * from the repos row (none without one), and syncedAt from the issues scope, whose rows the PRs are. */
export function prsOf(db: ReadModel, source: string, ref: RepoRef, state: PrState): RepoPrs {
  const author = prAuthorOf(source, ref);
  const counts = db.prCounts(source, ref.repository, author);
  return {
    rows: db.prs(source, ref.repository, state, { author, limit: PR_LIST_LIMIT }), counts, truncated: counts[state] > PR_LIST_LIMIT,
    canPush: db.repo(source, ref.repository)?.canPush ?? false, syncedAt: db.scope(source, ref.repository, 'issues')?.syncedAt ?? null,
  };
}

const CONVERSATION_LIMIT = 100; // as the page's timeline read (#758): the last 100 reviews and comments
const OPINIONS: readonly ReviewRow['state'][] = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];
const REVIEW_KINDS: Partial<Record<ReviewRow['state'], PrReviewEvent['kind']>> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' };
// A PR no poll or flag reached yet reads these, as the list's defaults (#186)
const NO_PULL: Omit<PullRow, 'source' | 'nodeId' | 'repository' | 'number'> = {
  draft: false, mergedAt: null, headSha: null, mergeState: 'unknown', checks: null, decision: null, readAt: null,
  headRef: '', baseRef: '', headOwner: '', baseOwner: '', commits: 0, additions: 0, deletions: 0, requested: [], closes: [], awaiting: [],
};

/** What the model holds of a PR's page (#187): every PrData field but the ones read on open. */
export type StoredPr = Omit<PrData, 'files' | 'threads' | 'truncated' | 'conflicts' | 'behindBy'>;

// GitHub logins ignore case
const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/** How many reviewers approve (#187): those whose latest approval, change request or dismissal is an approval, as latestOpinionatedReviews.
 * The reviews come oldest first, so a later entry replaces an earlier one. */
export function approvalsOf(reviews: ReviewRow[]): number {
  const latest = new Map(reviews.filter((r) => OPINIONS.includes(r.state)).map((r) => [r.author ?? GHOST, r.state]));
  return [...latest.values()].filter((state) => state === 'APPROVED').length;
}

const checkOf = (row: CheckRow): PrCheck => ({
  name: row.name, state: row.state, ...(row.url === null ? {} : { url: row.url }), ...(row.at === null ? {} : { at: row.at }),
  ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
});

// The head's checks (#187): the worst item's state, pending when only workflows await; none with neither, as the page showed
function checksOf(rows: CheckRow[], awaiting: string[]): PrChecks | undefined {
  if (rows.length === 0 && awaiting.length === 0) return undefined;
  const items = rows.map(checkOf);
  const at = latest(items.map((c) => c.at));
  return { state: worstOf(items.map((c) => c.state)) ?? 'pending', items, ...(at === undefined ? {} : { at }), ...(awaiting.length === 0 ? {} : { awaiting }) };
}

// The timeline's reviews and general comments (#758), each a stored row; a dismissed review is no event the page shows
function conversationOf(page: PrPage): Pick<StoredPr, 'reviews' | 'comments' | 'approvals'> {
  const reviews = page.reviews.flatMap((r): PrReviewEvent[] => {
    const kind = REVIEW_KINDS[r.state];
    return kind === undefined ? [] : [{ id: r.nodeId, author: r.author ?? GHOST, at: r.submittedAt, kind, text: r.body }];
  });
  const comments = page.comments.slice(-CONVERSATION_LIMIT).map((c) => ({ id: c.nodeId, author: c.author ?? GHOST, at: c.createdAt, text: c.body }));
  return { reviews: reviews.slice(-CONVERSATION_LIMIT), comments, approvals: approvalsOf(page.reviews) };
}

// The pulls row's part of the page: the poll's, the batch's and pulls/{n}'s fields
function pullFieldsOf(page: PrPage, login: string): Omit<StoredPr, 'url' | 'id' | 'number' | 'title' | 'state' | 'body' | 'author' | 'createdAt' | 'updatedAt' | 'methods' | 'viewer' | 'canPush' | 'canEdit' | 'reviews' | 'comments' | 'approvals'> {
  const pull = page.pull ?? NO_PULL;
  const checks = checksOf(page.checks, pull.awaiting);
  return {
    isDraft: pull.draft, mergeState: pull.mergeState, head: pull.headSha ?? '', headRef: pull.headRef, baseRef: pull.baseRef, headOwner: pull.headOwner,
    baseOwner: pull.baseOwner, commits: pull.commits, additions: pull.additions, deletions: pull.deletions, closes: pull.closes,
    reviewRequests: pull.requested.map((r) => ({ ...r, viewer: !r.team && sameLogin(r.reviewer, login) })),
    ...(pull.decision === null ? {} : { decision: pull.decision }), ...(checks === undefined ? {} : { checks }),
  };
}

/** One PR's page from the model (#187): the issues row's title, body, author and dates, the pulls row's fields, the reviews and comments, the
 * checks, and the repos row's methods and push rights. viewer is the source's login; canEdit is push rights or the PR being the login's. */
export function prDataOf(page: PrPage, login: string): StoredPr {
  const { issue, repo } = page;
  const canPush = repo?.canPush ?? false;
  const mergedAt = page.pull?.mergedAt ?? null;
  return {
    url: prLink(issue.repository, issue.number), id: issue.nodeId, number: issue.number, title: issue.title,
    state: issue.state === 'open' ? 'open' : (mergedAt === null ? 'closed' : 'merged'), body: issue.body, author: issue.author ?? GHOST,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt, methods: repo?.methods ?? [], viewer: login, canPush, canEdit: canPush || sameLogin(issue.author, login),
    ...pullFieldsOf(page, login), ...conversationOf(page),
  };
}
