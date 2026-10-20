import { ACTIONS_APP, checkState, decisionOf, isObject, mergeState, rowChecks } from '../pr-checks.js';
import { closesOf } from '../pr-github.js';
import { pullRequest } from '../sources/github-project.js';
import type { GhPullRequest } from '../sources/github-queries.js';
import type { MergeMethod, PrCheck, PrClosingIssue, PrMergeState, PrReviewDecision, ProjectPr } from '../types.js';
import type { CheckRow, CommentRow, IssueKind, IssueRow, PullChecks, PullFlags, PullPage, RepoRow, ReviewRow } from './rows.js';
import { sortedNames } from './rows.js';

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

// Labels by name, assignees by login, in GitHub's order: an issues row sorts them (sortedNames)
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
    labels: sortedNames(listOf(issue.labels, 'labels', 'name')), assignees: sortedNames(listOf(issue.assignees, 'assignees', 'login')),
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

// An Issue's or a PullRequest's row fields, as ISSUE_ROW_FIELDS (and PR_ROW_FIELDS, #187) answer them
function gqlRowOf(source: string, repository: string, item: Json, kind: IssueKind, state: IssueRow['state']): IssueRow {
  return {
    source, nodeId: textOf(item, 'id'), repository, number: countOf(item, 'number'), kind, state,
    title: textOf(item, 'title'), body: textOf(item, 'body'), author: loginOf(item.author),
    labels: sortedNames(listOf(objectOf(item.labels, 'labels').nodes, 'labels', 'name')),
    assignees: sortedNames(listOf(objectOf(item.assignees, 'assignees').nodes, 'assignees', 'login')),
    createdAt: textOf(item, 'createdAt'), updatedAt: textOf(item, 'updatedAt'), closedAt: nullableText(item, 'closedAt'),
    comments: countOf(objectOf(item.comments, 'comments'), 'totalCount'),
  };
}

/** An issue as ISSUE_ROW_FIELDS (github-repo-queries.ts) answers it: a GraphQL Issue is never a PR. */
export function issueFromGql(source: string, repository: string, json: unknown): IssueRow {
  const issue = objectOf(json, 'issue');
  const state = textOf(issue, 'state');
  if (state !== 'OPEN' && state !== 'CLOSED') throw new WireError('state');
  return gqlRowOf(source, repository, issue, 'issue', state === 'OPEN' ? 'open' : 'closed');
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

// GitHub's merge settings (#187): answered with push rights only; a null or a missing flag is not allowed
const METHOD_FLAGS: ReadonlyArray<[MergeMethod, string]> = [['merge', 'allow_merge_commit'], ['squash', 'allow_squash_merge'], ['rebase', 'allow_rebase_merge']];

/** `GET /repos/{o}/{r}` as its row (#181): no `permissions` (a read without push rights shown) cannot push; only a fork has `parent`. */
export function repoFromRest(source: string, repository: string, json: unknown): RepoRow {
  const repo = objectOf(json, 'repository');
  const permissions = optionalObject(repo.permissions, 'permissions');
  const parent = optionalObject(repo.parent, 'parent');
  return {
    source, repository, url: githubUrlOf(repo, 'html_url'), canPush: permissions === undefined ? false : flagOf(permissions, 'push'),
    issuesEnabled: flagOf(repo, 'has_issues'), forkParent: parent === undefined ? null : textOf(parent, 'full_name'), pushedAt: nullableText(repo, 'pushed_at'),
    methods: METHOD_FLAGS.flatMap(([method, flag]) => (repo[flag] === true ? [method] : [])),
  };
}

/** A page of `GET /repos/{o}/{r}/labels` as names (#181). */
export const labelNamesFromRest = (json: unknown): string[] => listOf(json, 'labels', 'name');

function arrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new WireError(what);
  return value;
}

/** A PR item of the issues endpoint as its flags (#186): draft, and pull_request.merged_at, which sets merged apart from closed. An issue
 * item has no pull_request, so none. */
export function pullFlagsFromRest(source: string, repository: string, json: unknown): PullFlags | undefined {
  const item = objectOf(json, 'issue');
  const pull = optionalObject(item.pull_request, 'pull_request');
  if (pull === undefined) return undefined;
  return { source, nodeId: textOf(item, 'node_id'), repository, number: countOf(item, 'number'), draft: item.draft === true, mergedAt: nullableText(pull, 'merged_at') };
}

// A head SHA goes into the check paths: SHA-1, or SHA-256
const HEAD_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** `GET /repos/{o}/{r}/pulls/{n}` as what the list polls (#186): the head SHA, and mergeable_state read as GraphQL's mergeStateStatus
 * (has_hooks is hooks, dirty conflicts, anything else unknown). */
export function pullFromRest(json: unknown): { headSha: string; mergeState: PrMergeState } {
  const pull = objectOf(json, 'pull request');
  const headSha = textOf(objectOf(pull.head, 'head'), 'sha');
  if (!HEAD_SHA.test(headSha)) throw new WireError('head.sha');
  return { headSha, mergeState: mergeState(nullableText(pull, 'mergeable_state')?.toUpperCase()) };
}

type Bucket = PrCheck['state'];
const WORST_FIRST: readonly Bucket[] = ['failure', 'pending', 'success'];
export const worstOf = (states: Bucket[]): Bucket | null => WORST_FIRST.find((s) => states.includes(s)) ?? null;

/** Every page of `commits/{sha}/check-runs` as its worst run (#186), in checkState's buckets: a run not completed is pending. None ran: null. */
export function runsReading(bodies: unknown[]): Bucket | null {
  const runs = bodies.flatMap((body) => arrayOf(objectOf(body, 'check runs').check_runs, 'check_runs'));
  return worstOf(runs.map((value) => {
    const run = objectOf(value, 'check run');
    return run.status === 'completed' ? checkState(nullableText(run, 'conclusion')?.toUpperCase()) : 'pending';
  }));
}

/** `commits/{sha}/status` as its combined state (#186). No status context: null, where GitHub still answers pending. */
export function statusReading(bodies: unknown[]): Bucket | null {
  const status = objectOf(bodies[0], 'status');
  return arrayOf(status.statuses, 'statuses').length === 0 ? null : checkState(textOf(status, 'state').toUpperCase());
}

/** `commits/{sha}/check-suites` as awaiting when an Actions workflow waits for a maintainer's approval (#854, #186). */
export function suitesReading(bodies: unknown[]): 'awaiting' | null {
  const suites = bodies.flatMap((body) => arrayOf(objectOf(body, 'check suites').check_suites, 'check_suites'));
  const isWaiting = suites.some((value) => {
    const suite = objectOf(value, 'check suite');
    return suite.conclusion === 'action_required' && optionalObject(suite.app, 'app')?.slug === ACTIONS_APP;
  });
  return isWaiting ? 'awaiting' : null;
}

/** The list's checks from the three readings (#186): the worst of the runs and the status; with neither, awaiting when a workflow waits,
 * else none. A stored reading that is no bucket counts as none. */
export function rollupOf(runs: string | null, status: string | null, suites: string | null): PullChecks | null {
  return WORST_FIRST.find((s) => s === runs || s === status) ?? (suites === 'awaiting' ? 'awaiting' : null);
}

/** One PR of the batch (#186): what the list read of it over GraphQL before. */
export interface PullGql { nodeId: string; decision: PrReviewDecision | null; mergeState: PrMergeState; checks: PullChecks | null; closes: PrClosingIssue[] }

/** The batch's answer (#186), one aliased node per PR (`p0`, `p1`, …), read as the list's rows were. A deleted PR answers a null node and
 * is skipped. */
export function pullsFromGql(json: unknown): PullGql[] {
  return Object.values(objectOf(json, 'batch')).flatMap((node) => {
    if (!isObject(node) || typeof node.id !== 'string') return [];
    return [{ nodeId: node.id, decision: decisionOf(node.reviewDecision) ?? null, mergeState: mergeState(node.mergeStateStatus), checks: rowChecks(node.headCommit) ?? null, closes: closesOf(node.closingIssuesReferences) }];
  });
}

// A deleted fork answers a null repo: no owner to name
const ownerOf = (repo: unknown): string => {
  const found = optionalObject(repo, 'repo');
  return found === undefined ? '' : textOf(objectOf(found.owner, 'owner'), 'login');
};

/** What GET pulls/{n} tells the page beyond the head and the merge state (#187): no request of its own. */
export function pullPageFromRest(json: unknown): PullPage {
  const pull = objectOf(json, 'pull request');
  const head = objectOf(pull.head, 'head');
  const base = objectOf(pull.base, 'base');
  const requested = [
    ...listOf(pull.requested_reviewers, 'requested_reviewers', 'login').map((reviewer) => ({ reviewer, team: false })),
    ...listOf(pull.requested_teams, 'requested_teams', 'slug').map((reviewer) => ({ reviewer, team: true })),
  ];
  return {
    headRef: textOf(head, 'ref'), baseRef: textOf(base, 'ref'), headOwner: ownerOf(head.repo), baseOwner: ownerOf(base.repo),
    commits: countOf(pull, 'commits'), additions: countOf(pull, 'additions'), deletions: countOf(pull, 'deletions'), requested,
  };
}

const REVIEW_STATES: readonly ReviewRow['state'][] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];
interface ReviewFields { nodeId: string; author: string | null; state: unknown; body: string; submittedAt: string | null }

// A submitted review's row (#187); a pending one (no submittedAt) or a state GitHub adds later is none
function reviewRowOf(source: string, repository: string, pullNodeId: string, fields: ReviewFields): ReviewRow | undefined {
  const state = REVIEW_STATES.find((s) => s === fields.state);
  if (state === undefined || fields.submittedAt === null) return undefined;
  return { source, nodeId: fields.nodeId, pullNodeId, repository, author: fields.author, state, body: fields.body, submittedAt: fields.submittedAt };
}

/** Every page of pulls/{n}/reviews as rows (#187); a PENDING review is skipped. */
export function reviewsFromRest(source: string, repository: string, pullNodeId: string, bodies: unknown[]): ReviewRow[] {
  return bodies.flatMap((body) => arrayOf(body, 'reviews')).flatMap((value) => {
    const review = objectOf(value, 'review');
    const fields = { nodeId: textOf(review, 'node_id'), author: loginOf(review.user), state: review.state, body: nullableText(review, 'body') ?? '', submittedAt: nullableText(review, 'submitted_at') };
    return reviewRowOf(source, repository, pullNodeId, fields) ?? [];
  });
}

/** A review as REVIEW_ROW_FIELDS answers it (#187), under the PR the same answer names. */
export function reviewFromGql(source: string, repository: string, pullNodeId: string, json: unknown): ReviewRow | undefined {
  const review = objectOf(json, 'review');
  return reviewRowOf(source, repository, pullNodeId, {
    nodeId: textOf(review, 'id'), author: loginOf(review.author), state: review.state, body: textOf(review, 'body'), submittedAt: nullableText(review, 'submittedAt'),
  });
}

/** A PR as PR_ROW_FIELDS answers it (#187): its issues row (MERGED is closed) and its flags, under its own node id. */
export function pullFromGql(source: string, repository: string, json: unknown): { issue: IssueRow; flags: PullFlags } {
  const pr = objectOf(json, 'pull request');
  const state = textOf(pr, 'state');
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') throw new WireError('state');
  const issue = gqlRowOf(source, repository, pr, 'pr', state === 'OPEN' ? 'open' : 'closed');
  return { issue, flags: { source, nodeId: issue.nodeId, repository, number: issue.number, draft: flagOf(pr, 'isDraft'), mergedAt: nullableText(pr, 'mergedAt') } };
}

// A check's link reaches the UI as an href, and a status context's target_url is any app's text: only https stays, so a javascript: or http:
// link is none. An empty or unparseable one is none too, as checkOf's filled
const linkOf = (json: Json, key: string): string | null => {
  const value = nullableText(json, key);
  if (value === null || value === '') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

/** The head's check runs, then its status contexts, as rows (#187), read as checkOf read them over GraphQL: a run not completed is pending,
 * and a context's one time is its start while it is pending. */
export function checkItemsFromRest(runs: unknown[], status: unknown[]): CheckRow[] {
  const runRows = runs.flatMap((body) => arrayOf(objectOf(body, 'check runs').check_runs, 'check_runs')).map((value): CheckRow => {
    const run = objectOf(value, 'check run');
    const state = run.status === 'completed' ? checkState(nullableText(run, 'conclusion')?.toUpperCase()) : 'pending';
    return { name: textOf(run, 'name'), state, url: linkOf(run, 'details_url'), startedAt: nullableText(run, 'started_at'), at: nullableText(run, 'completed_at') };
  });
  const contexts = arrayOf(objectOf(status[0], 'status').statuses, 'statuses').map((value): CheckRow => {
    const context = objectOf(value, 'status context');
    const state = checkState(textOf(context, 'state').toUpperCase());
    const at = nullableText(context, 'created_at');
    return { name: textOf(context, 'context'), state, url: linkOf(context, 'target_url'), startedAt: state === 'pending' ? at : null, at };
  });
  return [...runRows, ...contexts];
}

/** actions/runs?status=action_required as the workflows awaiting a maintainer's approval (#854, #187), once each; a nameless run is Actions'. */
export function awaitingFromRest(bodies: unknown[]): string[] {
  const runs = bodies.flatMap((body) => arrayOf(objectOf(body, 'workflow runs').workflow_runs, 'workflow_runs'));
  return [...new Set(runs.map((value) => nullableText(objectOf(value, 'workflow run'), 'name') ?? ACTIONS_APP))];
}
