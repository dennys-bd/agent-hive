import type { GqlJson } from '../sources/github-gql.js';
import { canPushOf } from '../pr-checks.js';
import { pullRequest } from '../sources/github-project.js';
import type { IssuePage, RepoIssue, RepoIssues, RepoSummary } from '../types.js';
import { ADD_COMMENT, ADD_LABELS, type GhIssue, type GhIssueConnection, type GhIssuePage, type GhRepoSummary, ISSUE_PAGE, ISSUE_STATE, REPO_ISSUE_PAGE_SIZE, REMOVE_LABELS, REPO_ISSUES, REPO_LABELS, repoSummariesQuery, UPDATE_ISSUE } from './github-repo-queries.js';
import type { RepoRef } from './repositories.js';

/** A repository's owner and name, the variables every query of one repository takes (#757). */
export const ownerName = (repository: string): { owner: string; name: string } => {
  const [owner = '', name = ''] = repository.split('/');
  return { owner, name };
};

// A key of a mutation's answer (#765): what a write hands the read model; undefined when GitHub answered none
const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined);

// The latest of the dates GitHub answered; ISO strings in GitHub's one format sort as the instants they name
const latest = (dates: (string | null | undefined)[]): string | undefined =>
  dates.filter((d): d is string => typeof d === 'string' && d !== '').sort().at(-1);

// One summary (#757, #854, #886): GitHub's counts and last activity, whether it is a fork and of what, the login's push rights, the ref's role,
// target and pair
function summaryOf(ref: RepoRef, repo: GhRepoSummary): RepoSummary {
  const lastActivity = latest([repo.pushedAt, repo.lastIssue.nodes[0]?.updatedAt, repo.lastPr.nodes[0]?.updatedAt]);
  return {
    repository: ref.repository, url: repo.url, workspace: ref.workspace, openPrs: repo.pullRequests.totalCount,
    openIssues: repo.open.totalCount, closedIssues: repo.closed.totalCount, canPush: canPushOf(repo.viewerPermission), issuesEnabled: repo.hasIssuesEnabled !== false,
    ...(lastActivity === undefined ? {} : { lastActivity }),
    ...(repo.isFork === true && repo.parent ? { fork: { parent: repo.parent.nameWithOwner } } : {}),
    ...(ref.role === undefined ? {} : { role: ref.role }), ...(ref.pr === undefined ? {} : { pr: ref.pr }),
    ...(ref.pair === undefined ? {} : { pair: ref.pair }),
  };
}

/** The sidebar's summaries (#757), in `refs`' order, in one query; a repository GitHub answers null for is left out. ponytail: GitHub's
 * errors win over its data (unwrap), so one repository the login cannot read fails the whole read as a 502. */
export async function readSummaries(gql: GqlJson, refs: RepoRef[]): Promise<RepoSummary[]> {
  if (refs.length === 0) return [];
  const variables = Object.fromEntries(refs.flatMap((ref, i): [string, string][] => {
    const { owner, name } = ownerName(ref.repository);
    return [[`o${i}`, owner], [`n${i}`, name]];
  }));
  const data = ((await gql(repoSummariesQuery(refs.length), variables)) ?? {}) as Record<string, GhRepoSummary | null | undefined>;
  return refs.flatMap((ref, i): RepoSummary[] => {
    const repo = data[`r${i}`];
    return repo ? [summaryOf(ref, repo)] : [];
  });
}

/** Ten pages (#757): as the native view's cap (#756); past it the list says truncated. */
export const REPO_ISSUE_LIMIT = 1000;

/** The `repository` of an answer, or an error naming it when GitHub answers none. */
export function repositoryOf<T>(data: unknown, repository: string): T {
  const repo = (data as { repository?: T | null } | null)?.repository;
  if (!repo) throw new Error(`repository not found: ${repository}`);
  return repo;
}

/** An issue's row (#757): labels and assignees by name, its closing PRs as the native view reads them. */
export function repoIssue(node: GhIssue): RepoIssue {
  return {
    number: node.number, title: node.title, url: node.url, updatedAt: node.updatedAt,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
    pullRequests: (node.closedByPullRequestsReferences?.nodes ?? []).map(pullRequest),
  };
}

/** A repository's issues in one state (#757), newest update first, up to REPO_ISSUE_LIMIT; `total` is GitHub's count. */
export async function readIssues(gql: GqlJson, repository: string, state: RepoIssues['state']): Promise<RepoIssues> {
  const issues: RepoIssue[] = [];
  let total = 0;
  let after: string | undefined;
  for (let page = 0; page < REPO_ISSUE_LIMIT / REPO_ISSUE_PAGE_SIZE; page++) {
    const data = await gql(REPO_ISSUES, { ...ownerName(repository), states: [state.toUpperCase()], ...(after === undefined ? {} : { after }) });
    const read = repositoryOf<{ issues: GhIssueConnection }>(data, repository).issues;
    total = read.totalCount;
    issues.push(...read.nodes.map(repoIssue));
    after = read.pageInfo.hasNextPage && read.pageInfo.endCursor ? read.pageInfo.endCursor : undefined;
    if (after === undefined) break;
  }
  return { state, total, issues, truncated: after !== undefined };
}

const GHOST = 'ghost'; // what GitHub itself shows for a deleted account

/** One issue's page (#757): its row, body, author and creation, and its first comments, oldest first, with GitHub's count. */
export async function readIssue(gql: GqlJson, repository: string, number: number): Promise<IssuePage> {
  const data = await gql(ISSUE_PAGE, { ...ownerName(repository), number });
  const issue = repositoryOf<{ issue?: GhIssuePage | null }>(data, repository).issue;
  if (!issue) throw new Error(`issue not found: ${repository}#${number}`);
  return {
    ...repoIssue(issue), repository, body: issue.body, author: issue.author?.login ?? GHOST, createdAt: issue.createdAt,
    comments: issue.comments.nodes.map((c) => ({ author: c.author?.login ?? GHOST, createdAt: c.createdAt, body: c.body, url: c.url })),
    commentCount: issue.comments.totalCount,
  };
}

/** The issue changed on GitHub since the page read it (#757): the edit is refused and nothing is written. */
export class IssueChanged extends Error {
  constructor() {
    super('the issue changed on GitHub since it was read');
    this.name = 'IssueChanged';
  }
}

/** The issue's node id and updatedAt, what every write reads first (#757). */
export async function issueState(gql: GqlJson, repository: string, number: number): Promise<{ id: string; updatedAt: string }> {
  const data = await gql(ISSUE_STATE, { ...ownerName(repository), number });
  const issue = repositoryOf<{ issue?: { id: string; updatedAt: string } | null }>(data, repository).issue;
  if (!issue) throw new Error(`issue not found: ${repository}#${number}`);
  return issue;
}

/** A title or description edit (#757): only the fields sent. */
export interface IssueEdit { title?: string; body?: string }

/** The edit, unless GitHub's updatedAt is not the one the page read: IssueChanged then. ponytail: the check reads then writes, so an edit
 * landing between the two is overwritten; updateIssue takes no expected updatedAt. Answers the updated issue (#765). */
export async function editIssue(gql: GqlJson, repository: string, number: number, edit: IssueEdit, updatedAt: string): Promise<unknown> {
  const issue = await issueState(gql, repository, number);
  if (issue.updatedAt !== updatedAt) throw new IssueChanged();
  return field(field(await gql(UPDATE_ISSUE, { id: issue.id, ...edit }), 'updateIssue'), 'issue');
}

// The repository's labels, name -> id, in GitHub's order by name
async function labelIds(gql: GqlJson, repository: string): Promise<Map<string, string>> {
  const data = await gql(REPO_LABELS, ownerName(repository));
  const labels = repositoryOf<{ labels: { nodes: { id: string; name: string }[] } }>(data, repository).labels.nodes;
  return new Map(labels.map((label) => [label.name, label.id]));
}

/** The repository's labels by name (#757): what the labels popover lists. */
export async function readLabels(gql: GqlJson, repository: string): Promise<string[]> {
  return [...(await labelIds(gql, repository)).keys()];
}

/** A label name the repository does not have (#757): the write is refused before anything is sent. */
export class UnknownLabel extends Error {
  constructor(name: string) {
    super(`label not in the repository: ${name}`);
    this.name = 'UnknownLabel';
  }
}

/** Adds and removes labels on the issue by name (#757), each list in one call; an empty list sends nothing. Labels check no updatedAt.
 * Answers the issue as the last mutation left it, undefined when none was sent (#765). */
export async function setLabels(gql: GqlJson, repository: string, number: number, add: string[], remove: string[]): Promise<unknown> {
  const ids = await labelIds(gql, repository);
  const idOf = (name: string): string => {
    const id = ids.get(name);
    if (id === undefined) throw new UnknownLabel(name);
    return id;
  };
  const adding = add.map(idOf);
  const removing = remove.map(idOf);
  const { id } = await issueState(gql, repository, number);
  const added = adding.length > 0 ? field(field(await gql(ADD_LABELS, { id, labels: adding }), 'addLabelsToLabelable'), 'labelable') : undefined;
  const removed = removing.length > 0 ? field(field(await gql(REMOVE_LABELS, { id, labels: removing }), 'removeLabelsFromLabelable'), 'labelable') : undefined;
  return removed ?? added;
}

/** A comment on the issue (#757), posted with the Hive's login. Answers the created comment and the issue it changed (#765). */
export async function comment(gql: GqlJson, repository: string, number: number, body: string): Promise<{ comment: unknown; issue: unknown }> {
  const { id } = await issueState(gql, repository, number);
  const payload = field(await gql(ADD_COMMENT, { id, body }), 'addComment');
  return { comment: field(field(payload, 'commentEdge'), 'node'), issue: field(payload, 'subject') };
}
