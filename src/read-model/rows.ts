// The read model's rows (#765): one per entity, keyed by the data's origin and GitHub's node id, so the REST sync and a GraphQL write meet
// on the same row. Not in src/types.ts: the spike's types stay in its own modules.

/** A row of the issues endpoint: an issue, or a PR (the endpoint answers both; the issue views leave PRs out). */
export type IssueKind = 'issue' | 'pr';

export interface IssueRow {
  source: string; nodeId: string; repository: string; number: number; kind: IssueKind;
  state: 'open' | 'closed'; title: string; body: string; author: string | null; labels: string[];
  createdAt: string; updatedAt: string; closedAt: string | null; comments: number;
}

export interface CommentRow {
  source: string; nodeId: string; issueNodeId: string; repository: string;
  author: string | null; body: string; createdAt: string; updatedAt: string;
}
