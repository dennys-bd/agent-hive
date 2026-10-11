import { issueUrl } from '../repos/issue-task.js';
import type { IssuePage, RepoIssue, RepoIssues } from '../types.js';
import type { CommentRow, IssueRow } from './rows.js';

const GHOST = 'ghost'; // what GitHub itself shows for a deleted account

// The spike's schema keeps neither assignees nor closing PRs (#765): the views show none, a gap the findings record
function repoIssueOf(row: IssueRow): RepoIssue {
  return { number: row.number, title: row.title, url: issueUrl(row.repository, row.number), labels: row.labels, assignees: [], updatedAt: row.updatedAt, pullRequests: [] };
}

/** A repository's issues in one state from the read model (#765), in the shape #757's list reads. */
export function issuesView(rows: IssueRow[], state: RepoIssues['state']): RepoIssues {
  return { state, total: rows.length, issues: rows.map(repoIssueOf), truncated: false };
}

/** An issue's page from the read model (#765). A comment row keeps no link of its own, so the issue's stands in. */
export function issuePageView(row: IssueRow, comments: CommentRow[]): IssuePage {
  const url = issueUrl(row.repository, row.number);
  return {
    ...repoIssueOf(row), repository: row.repository, body: row.body, author: row.author ?? GHOST, createdAt: row.createdAt,
    comments: comments.map((c) => ({ author: c.author ?? GHOST, createdAt: c.createdAt, body: c.body, url })), commentCount: row.comments,
  };
}
