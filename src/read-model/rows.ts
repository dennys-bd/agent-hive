import type { MergeMethod, PrCheck, PrThread, PrClosingIssue, PrMergeState, PrReviewDecision, PrRow, ProjectPr } from '../types.js';

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

/** A repository's own data (#181): one row per source and owner/name, replaced whole on a 200 of GET /repos/{o}/{r}. methods (#187): the
 * merge methods it allows; without push rights GitHub answers none. */
export interface RepoRow {
  source: string; repository: string; url: string; canPush: boolean; issuesEnabled: boolean; forkParent: string | null; pushedAt: string | null; methods: MergeMethod[];
}
/** A list row's checks (#186): the rollup's state, or a workflow awaiting a maintainer's approval. */
export type PullChecks = NonNullable<PrRow['checks']>;

/** A PR's own fields (#186), beside its issues row. Each writer sets only its own columns. */
export interface PullRow extends PullPage {
  source: string; nodeId: string; repository: string; number: number;
  draft: boolean; mergedAt: string | null; // the issues scope, the full listing and the refetch
  headSha: string | null; // the REST poll
  mergeState: PrMergeState; checks: PullChecks | null; // the REST poll on an open PR, the GraphQL batch on any other
  decision: PrReviewDecision | null; readAt: string | null; // the GraphQL batch; readAt: the issues row's updated_at it read at
  closes: PrClosingIssue[]; // the GraphQL batch (#187)
  awaiting: string[]; // the workflows awaiting approval, read by the poll when a suite awaits (#187)
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

/** The login of a source (#186): the last `:`-segment of `github:<host>:<login>`, as sourceOf writes it. */
export const sourceLogin = (source: string): string => source.slice(source.lastIndexOf(':') + 1);

/** A submitted review of a PR (#187), from pulls/{n}/reviews or a review write's answer. */
export interface ReviewRow {
  source: string; nodeId: string; pullNodeId: string; repository: string;
  author: string | null; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; body: string; submittedAt: string;
}
/** One check on a PR's head (#187): a check run or a status context, in the poll's order. */
export interface CheckRow { name: string; state: PrCheck['state']; url: string | null; startedAt: string | null; at: string | null }
/** What pulls/{n} tells the page beyond the poll's head and merge state (#187). */
export interface PullPage {
  headRef: string; baseRef: string; headOwner: string; baseOwner: string; commits: number; additions: number; deletions: number;
  requested: { reviewer: string; team: boolean }[];
}
/** Everything the PR page reads of one PR (#187): its issues row, its pulls row (none before the first poll or flag), its reviews oldest first,
 * its comments, its head's checks and its repository's row. */
export interface PrPage { issue: IssueRow; pull: PullRow | undefined; reviews: ReviewRow[]; comments: CommentRow[]; checks: CheckRow[]; repo: RepoRow | undefined }

/** A Project item's own columns (#190, #282): project is `<owner login>/<number>`; contentType the content's __typename, null when GitHub
 * answered none; issueNodeId the issues row it shows, set for an issue only. */
export interface ItemRow { source: string; nodeId: string; project: string; contentType: string | null; issueNodeId: string | null; updatedAt: string;
  /** The item's values as one stable string, so the replace rule sees a changed value at a tied updatedAt (#282) */ valuesSig: string }
/** One set value of an item (#282): kind is which GhFieldValue key holds it, so the rebuild restores a number as a number. */
export interface FieldValueRow { field: string; kind: 'name' | 'text' | 'number' | 'date' | 'title'; value: string }
/** Which side of an issue's relations a row is (#282): blockedBy and subIssue come with the items read, blocking with the relations query. */
export type RelationKind = 'blockedBy' | 'blocking' | 'subIssue';
/** One related issue (#282), in its kind's order. nodeId is a sub-issue's; a blocker ref has none. */
export interface RelationRow { kind: RelationKind; nodeId: string | null; number: number | null; title: string | null; state: string; repository: string | null }
/** What only the Project read says of an issue (#282), beside its REST columns. */
export interface IssueDetails {
  url: string; milestone: string | null; issueType: string | null; parentNumber: number | null; parentTitle: string | null;
  subIssuesTotal: number | null; subIssuesCompleted: number | null;
}
/** One item as the normalizer cuts it (#282): what one wire node becomes. An issue item carries its issue row, details and relations. */
export interface NormalizedItem { item: ItemRow; values: FieldValueRow[]; issue?: IssueRow; details?: IssueDetails; pullRequests: ProjectPr[]; relations?: RelationRow[] }
/** A Project item as stored (#282): its row and the relations marker, NULL never read, 1 read, 0 the issue was read and is gone (#190's three states). */
export interface StoredItem extends ItemRow { blockingRead: number | null }
/** A Project field as project_fields keeps it (#282): a single-select's options or an iteration field's iterations, by name. */
export interface ProjectFieldRow { name: string; dataType: string | null; options: string[] | null }
/** Every row one item's rebuild reads (#282). details is absent until a Project read wrote the issue's row's own columns. */
export interface StoredItemRows { item: StoredItem; values: FieldValueRow[]; issue?: IssueRow; details?: IssueDetails; pullRequests: ProjectPr[]; relations: RelationRow[] }

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Names in the order every view lists them (#282): by name, case-insensitive as SQLite's COLLATE NOCASE, a case-only tie by code unit, so the
 * REST and the GraphQL reader store the same list and neither rewrites the row the other just wrote. */
export const sortedNames = (names: readonly string[]): string[] => [...names].sort((a, b) => order(a.toLowerCase(), b.toLowerCase()) || order(a, b));

/** A PR's changes as read at `head` (#497): the raw diff and what the threads, the compare and the timeline told. One row per open PR. */
export interface PullChangesRow {
  head: string; diff: string; threads: PrThread[]; truncated: boolean; behindBy?: number;
  requestTimes: { reviewer: string; team: boolean; at: string }[]; // the timeline's review_requested times, as requestTimesOf reads them
}
