import { pullRequest } from '../sources/github-project.js';
import type { GhPullRequest } from '../sources/github-queries.js';
import type { ProjectPr } from '../types.js';
import type { CommentRow, IssueRow, RepoRow } from './rows.js';

// The wire is untrusted (#178): every field read is checked, and anything that is not GitHub's shape throws instead of storing half a row
type Json = Record<string, unknown>;

export class WireError extends Error {
  constructor(what: string) {
    super(`read model: unexpected ${what}`);
    this.name = 'WireError';
  }
}

function objectOf(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError(what);
  return value as Json;
}

function textOf(json: Json, key: string): string {
  const value = json[key];
  if (typeof value !== 'string') throw new WireError(key);
  return value;
}

function nullableText(json: Json, key: string): string | null {
  const value = json[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new WireError(key);
  return value;
}

function countOf(json: Json, key: string): number {
  const value = json[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new WireError(key);
  return value;
}

function flagOf(json: Json, key: string): boolean {
  const value = json[key];
  if (typeof value !== 'boolean') throw new WireError(key);
  return value;
}

// A deleted account answers a null user (REST) or author (GraphQL)
const loginOf = (value: unknown): string | null => (value === null || value === undefined ? null : textOf(objectOf(value, 'user'), 'login'));

// Labels by name, assignees by login, in GitHub's order
function listOf(value: unknown, what: string, key: string): string[] {
  if (!Array.isArray(value)) throw new WireError(what);
  return value.map((item) => textOf(objectOf(item, what), key));
}

/** An entry of `GET /repos/{o}/{r}/issues` or `…/issues/{n}` as its row: `pull_request` present makes it a PR. */
export function issueFromRest(source: string, repository: string, json: unknown): IssueRow {
  const issue = objectOf(json, 'issue');
  const state = textOf(issue, 'state');
  if (state !== 'open' && state !== 'closed') throw new WireError('state');
  return {
    source, nodeId: textOf(issue, 'node_id'), repository, number: countOf(issue, 'number'),
    kind: issue.pull_request === undefined || issue.pull_request === null ? 'issue' : 'pr', state,
    title: textOf(issue, 'title'), body: nullableText(issue, 'body') ?? '', author: loginOf(issue.user),
    labels: listOf(issue.labels, 'labels', 'name'), assignees: listOf(issue.assignees, 'assignees', 'login'),
    createdAt: textOf(issue, 'created_at'), updatedAt: textOf(issue, 'updated_at'), closedAt: nullableText(issue, 'closed_at'), comments: countOf(issue, 'comments'),
  };
}

/** A comment of `GET /repos/{o}/{r}/issues/comments` as its row. REST names its issue only by issue_url: `issueNodeIdOf` resolves the
 * number, and an issue not stored yet makes it undefined, so the sync waits for the issue instead of storing an orphan. */
export function commentFromRest(source: string, repository: string, json: unknown, issueNodeIdOf: (number: number) => string | undefined): CommentRow | undefined {
  const comment = objectOf(json, 'comment');
  const number = Number(/\/issues\/(\d+)$/.exec(textOf(comment, 'issue_url'))?.[1]);
  if (!Number.isInteger(number)) throw new WireError('issue_url');
  const row = {
    source, nodeId: textOf(comment, 'node_id'), repository, url: textOf(comment, 'html_url'), author: loginOf(comment.user),
    body: nullableText(comment, 'body') ?? '', createdAt: textOf(comment, 'created_at'), updatedAt: textOf(comment, 'updated_at'),
  };
  const issueNodeId = issueNodeIdOf(number);
  return issueNodeId === undefined ? undefined : { ...row, issueNodeId };
}

/** An issue as ISSUE_ROW_FIELDS (github-repo-queries.ts) answers it: a GraphQL Issue is never a PR. */
export function issueFromGql(source: string, repository: string, json: unknown): IssueRow {
  const issue = objectOf(json, 'issue');
  const state = textOf(issue, 'state');
  if (state !== 'OPEN' && state !== 'CLOSED') throw new WireError('state');
  return {
    source, nodeId: textOf(issue, 'id'), repository, number: countOf(issue, 'number'), kind: 'issue', state: state === 'OPEN' ? 'open' : 'closed',
    title: textOf(issue, 'title'), body: textOf(issue, 'body'), author: loginOf(issue.author),
    labels: listOf(objectOf(issue.labels, 'labels').nodes, 'labels', 'name'),
    assignees: listOf(objectOf(issue.assignees, 'assignees').nodes, 'assignees', 'login'),
    createdAt: textOf(issue, 'createdAt'), updatedAt: textOf(issue, 'updatedAt'), closedAt: nullableText(issue, 'closedAt'),
    comments: countOf(objectOf(issue.comments, 'comments'), 'totalCount'),
  };
}

/** A comment as COMMENT_ROW_FIELDS (github-repo-queries.ts) answers it, under the issue the mutation named. */
export function commentFromGql(source: string, repository: string, issueNodeId: string, json: unknown): CommentRow {
  const comment = objectOf(json, 'comment');
  return {
    source, nodeId: textOf(comment, 'id'), issueNodeId, repository, url: textOf(comment, 'url'), author: loginOf(comment.author),
    body: textOf(comment, 'body'), createdAt: textOf(comment, 'createdAt'), updatedAt: textOf(comment, 'updatedAt'),
  };
}

function ghPullRequestOf(value: unknown): GhPullRequest {
  const pr = objectOf(value, 'pull request');
  const rollup = pr.statusCheckRollup === null || pr.statusCheckRollup === undefined ? undefined : objectOf(pr.statusCheckRollup, 'statusCheckRollup');
  return {
    number: countOf(pr, 'number'), url: textOf(pr, 'url'), state: textOf(pr, 'state'), merged: flagOf(pr, 'merged'), isDraft: flagOf(pr, 'isDraft'),
    ...(rollup === undefined ? {} : { statusCheckRollup: { state: textOf(rollup, 'state') } }),
  };
}

/** An issue's closing PRs (#178), checked, then shaped by the views' own pullRequest so the stored shape is the one they show today. */
export function closingPrsFromGql(json: unknown): ProjectPr[] {
  const refs = objectOf(objectOf(json, 'issue').closedByPullRequestsReferences, 'closedByPullRequestsReferences');
  if (!Array.isArray(refs.nodes)) throw new WireError('closedByPullRequestsReferences');
  return refs.nodes.map((node) => pullRequest(ghPullRequestOf(node)));
}

const optionalObject = (value: unknown, what: string): Json | undefined => (value === null || value === undefined ? undefined : objectOf(value, what));

// html_url is served as a link: only a github.com page may be one
function githubUrlOf(obj: Json, key: string): string {
  const url = textOf(obj, key);
  if (!url.startsWith('https://github.com/')) throw new WireError(key);
  return url;
}

/** `GET /repos/{o}/{r}` as its row (#181): no `permissions` (a read without push rights shown) cannot push; only a fork has `parent`. */
export function repoFromRest(source: string, repository: string, json: unknown): RepoRow {
  const repo = objectOf(json, 'repository');
  const permissions = optionalObject(repo.permissions, 'permissions');
  const parent = optionalObject(repo.parent, 'parent');
  return {
    source, repository, url: githubUrlOf(repo, 'html_url'), canPush: permissions === undefined ? false : flagOf(permissions, 'push'),
    issuesEnabled: flagOf(repo, 'has_issues'), forkParent: parent === undefined ? null : textOf(parent, 'full_name'), pushedAt: nullableText(repo, 'pushed_at'),
  };
}

/** A page of `GET /repos/{o}/{r}/labels` as names (#181). */
export const labelNamesFromRest = (json: unknown): string[] => listOf(json, 'labels', 'name');
