import { issueUrl } from '../repos/issue-task.js';
import type { RepoRef } from '../repos/repositories.js';
import type { IssuePage, PrState, RepoIssue, RepoIssues, RepoPrs, RepoSummary, TaskComment } from '../types.js';
import type { ReadModel } from './db.js';
import { type CommentRow, type IssueView, sourceLogin } from './rows.js';

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
