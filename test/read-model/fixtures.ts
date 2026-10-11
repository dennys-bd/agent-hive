import type { RestAnswer, RestGet } from '../../src/read-model/rest.js';
import type { CommentRow, IssueRow } from '../../src/read-model/rows.js';

// Shaped after the answers recorded in Task 1's probe, trimmed to the fields read and with every name replaced (#765)
export const SOURCE = 'github:github.com:bia';
export const OTHER_SOURCE = 'github:ghe.example.com:bia';
export const REPO = 'acme/hive';
export const T1 = '2026-10-05T09:00:00Z';
export const T2 = '2026-10-05T10:00:00Z';
export const T3 = '2026-10-05T11:00:00Z';
export const T4 = '2026-10-05T12:00:00Z';
const CREATED = '2026-10-01T09:00:00Z';
const COMMENTED = '2026-10-02T09:00:00Z';

export const REST_ISSUE = {
  url: 'https://api.github.com/repos/acme/hive/issues/12', repository_url: 'https://api.github.com/repos/acme/hive', html_url: 'https://github.com/acme/hive/issues/12',
  id: 1012, node_id: 'I_12', number: 12, title: 'T12', user: { login: 'bia', id: 7 }, labels: [{ id: 3, node_id: 'LA_3', name: 'bug', color: 'd73a4a' }],
  state: 'closed', comments: 1, created_at: CREATED, updated_at: T1, closed_at: T1, body: 'b',
};
export const GQL_ISSUE = {
  id: 'I_12', number: 12, title: 'T12', body: 'b', state: 'CLOSED', createdAt: CREATED, updatedAt: T1, closedAt: T1, author: { login: 'bia' },
  labels: { nodes: [{ name: 'bug' }] }, comments: { totalCount: 1 },
};
export const ISSUE_ROW: IssueRow = {
  source: SOURCE, nodeId: 'I_12', repository: REPO, number: 12, kind: 'issue', state: 'closed', title: 'T12', body: 'b', author: 'bia', labels: ['bug'],
  createdAt: CREATED, updatedAt: T1, closedAt: T1, comments: 1,
};
export const REST_COMMENT = {
  url: 'https://api.github.com/repos/acme/hive/issues/comments/5', html_url: 'https://github.com/acme/hive/issues/12#issuecomment-5',
  issue_url: 'https://api.github.com/repos/acme/hive/issues/12', id: 5, node_id: 'IC_5', user: { login: 'bia', id: 7 }, created_at: COMMENTED, updated_at: COMMENTED, body: 'c',
};
export const GQL_COMMENT = { id: 'IC_5', body: 'c', createdAt: COMMENTED, updatedAt: COMMENTED, author: { login: 'bia' } };
export const COMMENT_ROW: CommentRow = { source: SOURCE, nodeId: 'IC_5', issueNodeId: 'I_12', repository: REPO, author: 'bia', body: 'c', createdAt: COMMENTED, updatedAt: COMMENTED };

export const issueRow = (n: number, updatedAt: string, extra: Partial<IssueRow> = {}): IssueRow => ({ ...ISSUE_ROW, nodeId: `I_${n}`, number: n, title: `T${n}`, updatedAt, ...extra });
export const commentRow = (id: string, issueNodeId: string, updatedAt = T1): CommentRow => ({ ...COMMENT_ROW, nodeId: id, issueNodeId, createdAt: updatedAt, updatedAt });
export const restIssue = (n: number, updatedAt: string): Record<string, unknown> => ({ ...REST_ISSUE, node_id: `I_${n}`, number: n, title: `T${n}`, updated_at: updatedAt });
export const restComment = (id: string, issue: number, updatedAt: string): Record<string, unknown> => ({
  ...REST_COMMENT, node_id: id, issue_url: `https://api.github.com/repos/acme/hive/issues/${issue}`, created_at: updatedAt, updated_at: updatedAt,
});

export const NOW = (): Date => new Date('2026-10-11T12:00:00Z');
export const ok = (body: unknown, extra: { next?: string; etag?: string } = {}): RestAnswer => ({ status: 200, body, ...extra });

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
