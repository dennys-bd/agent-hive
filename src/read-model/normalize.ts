import type { CommentRow, IssueRow } from './rows.js';

// The wire is untrusted (#765): every field read is checked, and anything that is not GitHub's shape throws instead of storing half a row
type Json = Record<string, unknown>;

class WireError extends Error {
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

// A deleted account answers a null user (REST) or author (GraphQL)
const loginOf = (value: unknown): string | null => (value === null || value === undefined ? null : textOf(objectOf(value, 'user'), 'login'));

function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WireError('labels');
  return value.map((label) => textOf(objectOf(label, 'label'), 'name'));
}

/** owner/name of a REST API link: `https://api.github.com/repos/<owner>/<name>` and anything under it. */
export function apiRepository(url: string): string {
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(url);
  if (match === null) throw new WireError('repository link');
  return match[1];
}

/** An entry of `GET /repos/{o}/{r}/issues` or `…/issues/{n}` as its row (#765): `pull_request` present makes it a PR. */
export function issueFromRest(source: string, repository: string, json: unknown): IssueRow {
  const issue = objectOf(json, 'issue');
  const state = textOf(issue, 'state');
  if (state !== 'open' && state !== 'closed') throw new WireError('state');
  return {
    source, nodeId: textOf(issue, 'node_id'), repository, number: countOf(issue, 'number'),
    kind: issue.pull_request === undefined || issue.pull_request === null ? 'issue' : 'pr', state,
    title: textOf(issue, 'title'), body: nullableText(issue, 'body') ?? '', author: loginOf(issue.user), labels: namesOf(issue.labels),
    createdAt: textOf(issue, 'created_at'), updatedAt: textOf(issue, 'updated_at'), closedAt: nullableText(issue, 'closed_at'), comments: countOf(issue, 'comments'),
  };
}

/** A comment of `GET /repos/{o}/{r}/issues/comments` as its row (#765). REST names its issue only by issue_url: `issueNodeIdOf` resolves the
 * number, and an issue not stored yet makes it undefined, so the sync waits for the issue instead of storing an orphan. */
export function commentFromRest(source: string, repository: string, json: unknown, issueNodeIdOf: (number: number) => string | undefined): CommentRow | undefined {
  const comment = objectOf(json, 'comment');
  const number = Number(/\/issues\/(\d+)$/.exec(textOf(comment, 'issue_url'))?.[1]);
  if (!Number.isInteger(number)) throw new WireError('issue_url');
  const row = {
    source, nodeId: textOf(comment, 'node_id'), repository, author: loginOf(comment.user), body: nullableText(comment, 'body') ?? '',
    createdAt: textOf(comment, 'created_at'), updatedAt: textOf(comment, 'updated_at'),
  };
  const issueNodeId = issueNodeIdOf(number);
  return issueNodeId === undefined ? undefined : { ...row, issueNodeId };
}

/** An issue as a write mutation answers it (#765, ISSUE_ROW_FIELDS): a GraphQL Issue is never a PR. */
export function issueFromGql(source: string, repository: string, json: unknown): IssueRow {
  const issue = objectOf(json, 'issue');
  const state = textOf(issue, 'state');
  if (state !== 'OPEN' && state !== 'CLOSED') throw new WireError('state');
  return {
    source, nodeId: textOf(issue, 'id'), repository, number: countOf(issue, 'number'), kind: 'issue', state: state === 'OPEN' ? 'open' : 'closed',
    title: textOf(issue, 'title'), body: textOf(issue, 'body'), author: loginOf(issue.author), labels: namesOf(objectOf(issue.labels, 'labels').nodes),
    createdAt: textOf(issue, 'createdAt'), updatedAt: textOf(issue, 'updatedAt'), closedAt: nullableText(issue, 'closedAt'),
    comments: countOf(objectOf(issue.comments, 'comments'), 'totalCount'),
  };
}

/** A comment as addComment answers it (#765, COMMENT_ROW_FIELDS), under the issue the mutation named. */
export function commentFromGql(source: string, repository: string, issueNodeId: string, json: unknown): CommentRow {
  const comment = objectOf(json, 'comment');
  return {
    source, nodeId: textOf(comment, 'id'), issueNodeId, repository, author: loginOf(comment.author), body: textOf(comment, 'body'),
    createdAt: textOf(comment, 'createdAt'), updatedAt: textOf(comment, 'updatedAt'),
  };
}
