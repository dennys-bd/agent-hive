import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import type { RestAnswer, RestGet, RestQuota } from '../../src/read-model/rest.js';
import type { CommentRow, IssueRow, PullKey, RepoRow } from '../../src/read-model/rows.js';
import type { GhPullRequest } from '../../src/sources/github-queries.js';
import type { RepoRef } from '../../src/repos/repositories.js';
import type { Gql, ProjectPr } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';

// Shaped after the answers the spike's probe recorded (#765), trimmed to the fields read and with every name replaced (#178)
export const SOURCE = 'github:github.com:bia';
export const OTHER_SOURCE = 'github:ghe.example.com:bia';
export const REPO = 'acme/hive';
export const REF: RepoRef = { repository: REPO, workspace: 'hive' };
export const T1 = '2026-10-05T09:00:00Z';
export const T2 = '2026-10-05T10:00:00Z';
export const T3 = '2026-10-05T11:00:00Z';
const CREATED = '2026-10-01T09:00:00Z';
const COMMENTED = '2026-10-02T09:00:00Z';
const COMMENT_URL = 'https://github.com/acme/hive/issues/12#issuecomment-5';

// GitHub's order, not the number's: the database answers them by number
export const GQL_CLOSING_PRS: GhPullRequest[] = [
  { number: 31, url: 'https://github.com/acme/hive/pull/31', state: 'OPEN', merged: false, isDraft: true, statusCheckRollup: null },
  { number: 30, url: 'https://github.com/acme/hive/pull/30', state: 'MERGED', merged: true, isDraft: false, statusCheckRollup: { state: 'SUCCESS' } },
];
export const CLOSING_PRS: ProjectPr[] = [
  { number: 30, url: 'https://github.com/acme/hive/pull/30', state: 'merged', checks: 'green' },
  { number: 31, url: 'https://github.com/acme/hive/pull/31', state: 'open', draft: true },
];

export const REST_ISSUE = {
  url: 'https://api.github.com/repos/acme/hive/issues/12', repository_url: 'https://api.github.com/repos/acme/hive', html_url: 'https://github.com/acme/hive/issues/12',
  id: 1012, node_id: 'I_12', number: 12, title: 'T12', user: { login: 'bia', id: 7 }, labels: [{ id: 3, node_id: 'LA_3', name: 'bug', color: 'd73a4a' }],
  assignees: [{ login: 'bia', id: 7 }, { login: 'caio', id: 8 }],
  state: 'closed', comments: 1, created_at: CREATED, updated_at: T1, closed_at: T1, body: 'b',
};
export const GQL_ISSUE = {
  id: 'I_12', number: 12, title: 'T12', body: 'b', state: 'CLOSED', createdAt: CREATED, updatedAt: T1, closedAt: T1, author: { login: 'bia' },
  labels: { nodes: [{ name: 'bug' }] }, assignees: { nodes: [{ login: 'bia' }, { login: 'caio' }] }, comments: { totalCount: 1 },
  closedByPullRequestsReferences: { nodes: GQL_CLOSING_PRS },
};
export const ISSUE_ROW: IssueRow = {
  source: SOURCE, nodeId: 'I_12', repository: REPO, number: 12, kind: 'issue', state: 'closed', title: 'T12', body: 'b', author: 'bia',
  labels: ['bug'], assignees: ['bia', 'caio'], createdAt: CREATED, updatedAt: T1, closedAt: T1, comments: 1,
};
export const REPO_ROW: RepoRow = { source: SOURCE, repository: REPO, url: 'https://github.com/acme/hive', canPush: true, issuesEnabled: true, forkParent: null, pushedAt: T1 };
export const REST_COMMENT = {
  url: 'https://api.github.com/repos/acme/hive/issues/comments/5', html_url: COMMENT_URL,
  issue_url: 'https://api.github.com/repos/acme/hive/issues/12', id: 5, node_id: 'IC_5', user: { login: 'bia', id: 7 }, created_at: COMMENTED, updated_at: COMMENTED, body: 'c',
};
export const GQL_COMMENT = { id: 'IC_5', url: COMMENT_URL, body: 'c', createdAt: COMMENTED, updatedAt: COMMENTED, author: { login: 'bia' } };
export const COMMENT_ROW: CommentRow = {
  source: SOURCE, nodeId: 'IC_5', issueNodeId: 'I_12', repository: REPO, url: COMMENT_URL, author: 'bia', body: 'c', createdAt: COMMENTED, updatedAt: COMMENTED,
};

export const issueRow = (n: number, updatedAt: string, extra: Partial<IssueRow> = {}): IssueRow => ({ ...ISSUE_ROW, nodeId: `I_${n}`, number: n, title: `T${n}`, updatedAt, ...extra });
export const commentRow = (id: string, issueNodeId: string, updatedAt = T1): CommentRow => ({ ...COMMENT_ROW, nodeId: id, issueNodeId, createdAt: updatedAt, updatedAt });
/** A PR's issues row (#186): open, node id PR_<n>, as GitHub names a PR's node. */
export const prIssueRow = (n: number, updatedAt: string, extra: Partial<IssueRow> = {}): IssueRow =>
  issueRow(n, updatedAt, { nodeId: `PR_${n}`, kind: 'pr', state: 'open', closedAt: null, ...extra });
export const pullKey = (n: number): PullKey => ({ source: SOURCE, nodeId: `PR_${n}`, repository: REPO, number: n });
export const HEAD = 'a'.repeat(40);

export const NOW = (): Date => new Date('2026-10-12T12:00:00Z');
export const SYNCED = NOW().toISOString();
export const ok = (body: unknown, extra: { next?: string; etag?: string; quota?: RestQuota } = {}): RestAnswer => ({ status: 200, body, ...extra });
export const REST_REPO = {
  id: 1, node_id: 'R_1', full_name: 'acme/hive', html_url: 'https://github.com/acme/hive', fork: false, has_issues: true, pushed_at: T1,
  permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
};
export const restLabel = (name: string): Record<string, unknown> => ({ id: name.length, node_id: `LA_${name}`, name, color: 'ededed', default: false });
/** What the repo and labels scopes answer in a first round (#181): the repository, and no label. */
export const REPO_SCOPES: RestAnswer[] = [ok(REST_REPO), ok([])];
export const restIssue = (n: number, updatedAt: string): Record<string, unknown> => ({ ...REST_ISSUE, node_id: `I_${n}`, number: n, title: `T${n}`, updated_at: updatedAt });

/** A PR item of the issues endpoint (#186): open, or closed and merged when `mergedAt` is set; `extra` overrides any field. */
export const restPr = (n: number, updatedAt: string, mergedAt: string | null = null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...restIssue(n, updatedAt), node_id: `PR_${n}`, state: mergedAt === null ? 'open' : 'closed', closed_at: mergedAt, draft: false,
  pull_request: { url: `https://api.github.com/repos/acme/hive/pulls/${n}`, merged_at: mergedAt }, ...extra,
});
export const restComment = (id: string, issue: number, updatedAt: string): Record<string, unknown> => ({
  ...REST_COMMENT, node_id: id, issue_url: `https://api.github.com/repos/acme/hive/issues/${issue}`, created_at: updatedAt, updated_at: updatedAt,
});

/** A RestGet answering `answers` in order, recording every [path, etag] it was asked. */
export function fakeRest(answers: RestAnswer[]): { rest: RestGet; calls: [string, string | undefined][] } {
  const queue = [...answers];
  const calls: [string, string | undefined][] = [];
  const rest: RestGet = async (path, etag) => {
    calls.push([path, etag]);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`no answer left for ${path}`);
    return answer;
  };
  return { rest, calls };
}

/** A promise the test settles by hand: a slow gh, or the moment one was called. */
export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A read model in a temporary file, closed after the test. */
export async function tempModel(t: TestContext): Promise<ReadModel> {
  const { db } = await openReadModel(join(await tempDir(t, 'read-model-'), READ_MODEL_FILE));
  t.after(() => db.close());
  return db;
}

/** A Gql answering ISSUE_CLOSING_PRS with these closing PRs, recording the variables of every call. */
export function fakeLinks(nodes: GhPullRequest[] = []): { gql: Gql; calls: unknown[] } {
  const calls: unknown[] = [];
  const gql: Gql = async (_query, variables) => {
    calls.push(variables);
    return { repository: { issue: { closedByPullRequestsReferences: { nodes } } } };
  };
  return { gql, calls };
}

/** A Gql that must never be called (#186): a round with no PR to read, or a PR's refetch. */
export const NO_GQL: Gql = async () => {
  throw new Error('a read called GraphQL');
};
