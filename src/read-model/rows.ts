import type { PrMergeState, PrReviewDecision, PrRow, ProjectPr } from '../types.js';

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

/** A repository's own data (#181): one row per source and owner/name, replaced whole on a 200 of GET /repos/{o}/{r}. */
export interface RepoRow { source: string; repository: string; url: string; canPush: boolean; issuesEnabled: boolean; forkParent: string | null; pushedAt: string | null }
/** A list row's checks (#186): the rollup's state, or a workflow awaiting a maintainer's approval. */
export type PullChecks = NonNullable<PrRow['checks']>;

/** A PR's own fields (#186), beside its issues row. Each writer sets only its own columns. */
export interface PullRow {
  source: string; nodeId: string; repository: string; number: number;
  draft: boolean; mergedAt: string | null; // the issues scope, the full listing and the refetch
  headSha: string | null; // the REST poll
  mergeState: PrMergeState; checks: PullChecks | null; // the REST poll on an open PR, the GraphQL batch on any other
  decision: PrReviewDecision | null; readAt: string | null; // the GraphQL batch; readAt: the issues row's updated_at it read at
}
export type PullKey = Pick<PullRow, 'source' | 'nodeId' | 'repository' | 'number'>;
/** What a PR item of the issues endpoint tells (#186): draft, and merged_at, which sets merged apart from closed. */
export type PullFlags = PullKey & Pick<PullRow, 'draft' | 'mergedAt'>;
/** What the batch read of one PR (#186); settled: the merge state and checks of a PR that is not open, which no poll reads. */
export interface PullRead { decision: PrReviewDecision | null; readAt: string; settled?: Pick<PullRow, 'mergeState' | 'checks'> }
/** What the poll read of one open PR (#186). */
export type PullPoll = Pick<PullRow, 'mergeState' | 'checks'> & { headSha: string };
/** A PR the batch is due to read (#186): its issues row's updated_at moved past read_at, or it was never read. */
export interface PullToRead { nodeId: string; number: number; isOpen: boolean; updatedAt: string }
/** An open PR the poll reads (#186), with what the last poll stored. */
export interface OpenPull { nodeId: string; number: number; headSha: string | null; mergeState: PrMergeState }
