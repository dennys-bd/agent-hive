// The repositories' GraphQL (#757): the issue writes, which ask back their row's fields for the read model (#183), the labels they resolve and the refetch's closing PRs; the read routes answer from the read model (#181).
// Every query asks rateLimit, the reading server-repos keeps as the Hive's own quota; a mutation cannot ask it (only Query has it).
export const RATE = 'rateLimit { limit remaining resetAt }';
export const LABEL_LIMIT = 50; // ponytail: an issue with more labels shows its first 50
export const ASSIGNEE_LIMIT = 10; // GitHub's own cap on assignees per issue: never under-read
/** What a write asks GitHub back of an issue (#178, #183): every field of its row, with the repository views' limits. Here and not in
 * read-model/normalize.ts, which imports these limits: the other way round is an import cycle. */
export const ISSUE_ROW_FIELDS = 'id number title body state createdAt updatedAt closedAt author { login } comments { totalCount } '
  + `labels(first: ${LABEL_LIMIT}) { nodes { name } } assignees(first: ${ASSIGNEE_LIMIT}) { nodes { login } }`;
/** What addComment asks back of a comment (#178, #183). */
export const COMMENT_ROW_FIELDS = 'id url body createdAt updatedAt author { login }';
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

/** A title or body edit (#757): a variable not sent leaves its field as it is. Asks back the issue's row (#183). */
export const UPDATE_ISSUE = `mutation($id: ID!, $title: String, $body: String) { updateIssue(input: { id: $id, title: $title, body: $body }) { issue { ${ISSUE_ROW_FIELDS} } } }`;

const REPO_LABEL_LIMIT = 100; // ponytail: the labels popover lists a repository's first 100 by name

/** A repository's labels by name (#757), with the ids the label writes take. */
export const REPO_LABELS = `query($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) { labels(first: ${REPO_LABEL_LIMIT}, orderBy: { field: NAME, direction: ASC }) { nodes { id name } } }
}`;
// The labelable is an interface: only an Issue's fields are asked, the one kind these routes write (#183)
export const ADD_LABELS = `mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { labelable { ... on Issue { ${ISSUE_ROW_FIELDS} } } } }`;
export const REMOVE_LABELS = `mutation($id: ID!, $labels: [ID!]!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labels }) { labelable { ... on Issue { ${ISSUE_ROW_FIELDS} } } } }`;
// subject too: the comment moves its issue's count and updatedAt, and the same answer brings them (#183)
export const ADD_COMMENT = `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { ${COMMENT_ROW_FIELDS} } } subject { ... on Issue { ${ISSUE_ROW_FIELDS} } } } }`;
