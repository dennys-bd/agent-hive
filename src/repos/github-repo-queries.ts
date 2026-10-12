import type { GhPullRequest } from '../sources/github-queries.js';
// The repositories' GraphQL (#757): the flow sidebar's summaries, a repository's issues, an issue's page and labels, and the issue writes.
// Every query asks rateLimit, the reading server-repos keeps as the Hive's own quota; a mutation cannot ask it (only Query has it).
export const RATE = 'rateLimit { limit remaining resetAt }';
const LATEST = 'first: 1, orderBy: { field: UPDATED_AT, direction: DESC }';
const SUMMARY_FIELDS = 'url pushedAt isFork parent { nameWithOwner } viewerPermission hasIssuesEnabled pullRequests(states: OPEN) { totalCount } open: issues(states: OPEN) { totalCount } '
  + `closed: issues(states: CLOSED) { totalCount } lastIssue: issues(${LATEST}) { nodes { updatedAt } } lastPr: pullRequests(${LATEST}) { nodes { updatedAt } }`;

/** The sidebar's summaries (#757): one alias per repository, r0…r{count-1}, owner and name as the variables o<i> and n<i>, never in the text. */
export function repoSummariesQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, i) => i);
  const params = indexes.map((i) => `$o${i}: String!, $n${i}: String!`).join(', ');
  const aliases = indexes.map((i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ${SUMMARY_FIELDS} }`).join(' ');
  return `query(${params}) { ${RATE} ${aliases} }`;
}

interface GhCount { totalCount: number }
interface GhUpdated { nodes: { updatedAt: string }[] }
/** One alias of the summaries' answer (#757). */
export interface GhRepoSummary { url: string; pushedAt?: string | null; isFork?: boolean; parent?: { nameWithOwner: string } | null; viewerPermission?: string | null; hasIssuesEnabled?: boolean; pullRequests: GhCount; open: GhCount; closed: GhCount; lastIssue: GhUpdated; lastPr: GhUpdated }

export const REPO_ISSUE_PAGE_SIZE = 100; // GitHub's cap per page
export const LABEL_LIMIT = 50; // ponytail: an issue with more labels shows its first 50
export const ASSIGNEE_LIMIT = 10; // GitHub's own cap on assignees per issue: never under-read
const PR_LIMIT = 10; // ponytail: an issue closed by more PRs shows its first 10, as in the native view (#756)
const CLOSING_PRS = `closedByPullRequestsReferences(first: ${PR_LIMIT}, includeClosedPrs: true) { nodes { number url state merged isDraft statusCheckRollup { state } } }`;
export const ISSUE_FIELDS = `number title url updatedAt labels(first: ${LABEL_LIMIT}) { nodes { name } } assignees(first: ${ASSIGNEE_LIMIT}) { nodes { login } } ${CLOSING_PRS}`;

/** An issue's closing PRs alone (#180): the read model's refetch, whose REST reads carry none. */
export const ISSUE_CLOSING_PRS = `query($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) { issue(number: $number) { ${CLOSING_PRS} } }
}`;

/** A repository's issues in one state (#757), most recently updated first, a page at a time. */
export const REPO_ISSUES = `query($owner: String!, $name: String!, $states: [IssueState!], $after: String) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    issues(first: ${REPO_ISSUE_PAGE_SIZE}, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }
}`;

/** An issue as REPO_ISSUES answers it (#757). */
export interface GhIssue {
  number: number; title: string; url: string; updatedAt: string;
  labels?: { nodes: { name: string }[] } | null; assignees?: { nodes: { login: string }[] } | null; closedByPullRequestsReferences?: { nodes: GhPullRequest[] } | null;
}
export interface GhIssueConnection { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: GhIssue[] }

const COMMENT_LIMIT = 100; // the page's comments: the first 100, oldest first; the heading keeps GitHub's count and links the rest

/** One issue's page (#757): its row's fields, then its body, author and creation, and its first comments. */
export const ISSUE_PAGE = `query($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ${ISSUE_FIELDS}
      body createdAt author { login }
      comments(first: ${COMMENT_LIMIT}) { totalCount nodes { author { login } createdAt body url } }
    }
  }
}`;

interface GhAuthor { login: string }
/** An issue as ISSUE_PAGE answers it (#757); a deleted account answers a null author. */
export interface GhIssuePage extends GhIssue {
  body: string; createdAt: string; author?: GhAuthor | null;
  comments: { totalCount: number; nodes: { author?: GhAuthor | null; createdAt: string; body: string; url: string }[] };
}

/** What a write needs of an issue (#757): its node id, and its updatedAt for the edit's conflict check. */
export const ISSUE_STATE = `query($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) { issue(number: $number) { id updatedAt } }
}`;

/** A title or body edit (#757): a variable not sent leaves its field as it is. */
export const UPDATE_ISSUE = 'mutation($id: ID!, $title: String, $body: String) { updateIssue(input: { id: $id, title: $title, body: $body }) { issue { id } } }';

const REPO_LABEL_LIMIT = 100; // ponytail: the labels popover lists a repository's first 100 by name

/** A repository's labels by name (#757), with the ids the label writes take. */
export const REPO_LABELS = `query($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) { labels(first: ${REPO_LABEL_LIMIT}, orderBy: { field: NAME, direction: ASC }) { nodes { id name } } }
}`;
export const ADD_LABELS = 'mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }';
export const REMOVE_LABELS = 'mutation($id: ID!, $labels: [ID!]!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }';
export const ADD_COMMENT = 'mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }';
