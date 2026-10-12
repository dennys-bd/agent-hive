// The repositories' GraphQL (#757): the issue writes, the labels they resolve and the refetch's closing PRs; the read routes answer from the read model (#181).
// Every query asks rateLimit, the reading server-repos keeps as the Hive's own quota; a mutation cannot ask it (only Query has it).
export const RATE = 'rateLimit { limit remaining resetAt }';
export const LABEL_LIMIT = 50; // ponytail: an issue with more labels shows its first 50
export const ASSIGNEE_LIMIT = 10; // GitHub's own cap on assignees per issue: never under-read
const PR_LIMIT = 10; // ponytail: an issue closed by more PRs shows its first 10, as in the native view (#756)
const CLOSING_PRS = `closedByPullRequestsReferences(first: ${PR_LIMIT}, includeClosedPrs: true) { nodes { number url state merged isDraft statusCheckRollup { state } } }`;

/** An issue's closing PRs alone (#180): the read model's refetch, whose REST reads carry none. */
export const ISSUE_CLOSING_PRS = `query($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) { issue(number: $number) { ${CLOSING_PRS} } }
}`;

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
