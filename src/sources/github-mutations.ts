// One Project field's value by kind (#686): the variable is named after GitHub's input key, so a kind is one line. SET_OPTION is the Status
// write setColumn sends (#756) and any single-select's
const setValue = (key: string, type: string): string => `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $${key}: ${type}) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { ${key}: $${key} } }) {
    projectV2Item { id }
  }
}`;
export const SET_OPTION = setValue('singleSelectOptionId', 'String!');
export const SET_TEXT = setValue('text', 'String!');
export const SET_NUMBER = setValue('number', 'Float!');
export const SET_DATE = setValue('date', 'Date!');
export const SET_ITERATION = setValue('iterationId', 'String!');
export const CLEAR_FIELD = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } }
}`;
// The issue's own fields (#686): its milestone and its type. A clear sends null, which no scalar variable carries: it is in the text
export const SET_MILESTONE = `mutation($issueId: ID!, $milestoneId: ID!) {
  updateIssue(input: { id: $issueId, milestoneId: $milestoneId }) { issue { id } }
}`;
export const CLEAR_MILESTONE = `mutation($issueId: ID!) {
  updateIssue(input: { id: $issueId, milestoneId: null }) { issue { id } }
}`;
export const SET_ISSUE_TYPE = `mutation($issueId: ID!, $issueTypeId: ID!) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) { issue { id } }
}`;
export const CLEAR_ISSUE_TYPE = `mutation($issueId: ID!) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: null }) { issue { id } }
}`;

/** The assignees a write adds or removes (#686): one `ID!` variable per user (`u0`, `u1`…), since a Gql variable is a scalar. */
export function assigneesMutation(op: 'addAssigneesToAssignable' | 'removeAssigneesFromAssignable', count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$u${i}`);
  return `mutation($assignableId: ID!, ${vars.map((v) => `${v}: ID!`).join(', ')}) {
  ${op}(input: { assignableId: $assignableId, assigneeIds: [${vars.join(', ')}] }) { clientMutationId }
}`;
}

/** The labels a write adds or removes (#60): one `ID!` variable per label (`l0`, `l1`…), as assigneesMutation. */
export function labelsMutation(op: 'addLabelsToLabelable' | 'removeLabelsFromLabelable', count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$l${i}`);
  return `mutation($labelableId: ID!, ${vars.map((v) => `${v}: ID!`).join(', ')}) {
  ${op}(input: { labelableId: $labelableId, labelIds: [${vars.join(', ')}] }) { clientMutationId }
}`;
}
