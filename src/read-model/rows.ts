import type { ProjectPr } from '../types.js';

// The read model's rows (#178): one per entity, keyed by the data's source and GitHub's node id, so the REST sync and a GraphQL write meet
// on the same row. Not in src/types.ts: they are the module's own.

/** A row of the issues endpoint: an issue, or a PR (the endpoint answers both; the issue views leave PRs out). */
export type IssueKind = 'issue' | 'pr';

export interface IssueRow {
  source: string; nodeId: string; repository: string; number: number; kind: IssueKind;
  state: 'open' | 'closed'; title: string; body: string; author: string | null;
  labels: string[]; assignees: string[];
  createdAt: string; updatedAt: string; closedAt: string | null; comments: number;
}

export interface CommentRow {
  source: string; nodeId: string; issueNodeId: string; repository: string; url: string;
  author: string | null; body: string; createdAt: string; updatedAt: string;
}

/** An issue as the views read it: its row and the PRs that close it. */
export interface IssueView extends IssueRow { pullRequests: ProjectPr[] }

/** Where a write comes from: a sync page, or a write's confirmed answer. */
export type UpsertOrigin = 'sync' | 'write';

/** The origin of a row: a login on a host. The caller reads the login, so where it comes from stays open (#178). */
export const sourceOf = (host: string, login: string): string => `github:${host}:${login}`;
