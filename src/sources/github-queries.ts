import type { Item } from '../types.js';

export const PAGE_SIZE = 100; // raw GraphQL caps `items` at 100 per page; the adapter pages up to ITEM_LIMIT
const PROJECT_LIMIT = 100;
const RELATION_LIMIT = 50; // ponytail: no pagination, GitHub's own cap per type: an issue with more blockers, blocked issues or open sub-issues than this is under-reported
const COMMENT_LIMIT = 100; // ponytail: one page, oldest first; a longer thread shows its first 100 (paging is a later issue)
const ASSIGNEE_LIMIT = 10; // GitHub's own cap on assignees per issue: never under-reported
const LABEL_LIMIT = 50; // ponytail: no pagination, an issue with more labels than this is under-reported by the task filter
const REPO_LABEL_LIMIT = 100; // GitHub's page size: a repository's labels are the picker's options (#60); ponytail: one page, a label past it is refused as unknown
const SUB_ISSUE_LIMIT = 50; // ponytail: no pagination, an epic's children past this keep their own source position instead of following it, and are missing from its children and progress (#28)
const FIELD_VALUE_LIMIT = 20; // ponytail: no pagination, an item with more set field values than this is under-read by a filter or project rule (#245, #293)
const FIELD_LIMIT = 50; // ponytail: one page of a project's fields; a project with more lists its first 50 as filter criteria (#245)
const PROJECT_PR_LIMIT = 10; // ponytail: an issue closed by more PRs than this shows its first 10 in the native view (#756)
const ASSIGNABLE_LIMIT = 100; // ponytail: one page of a repository's assignable users; a login past it is refused as unknown (#686), paging when a repository outgrows it
const MILESTONE_LIMIT = 100; // ponytail: one page of a repository's open milestones (#686)
const ISSUE_TYPE_LIMIT = 25; // GitHub's own cap on an organization's issue types: never under-read
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/;
// #56: what a BlockerRef shows of each side of a relation, and the repository that decides whether its id is short
const BLOCKER_NODES = 'nodes { number title state repository { nameWithOwner } }';

// `repositoryOwner` resolves a user or an organization in one query, so the adapter never needs to know which kind it was given.
export const PROJECTS = `query($login: String!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner { projectsV2(first: ${PROJECT_LIMIT}) { nodes { number title url closed } } }
  }
}`;

// One call for what used to take `gh project view` plus `gh project field-list`: the project id and the Status options.
export const PROJECT_FIELDS = `query($login: String!, $number: Int!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
      }
    }
  }
}`;

const REPOSITORY_LIMIT = 100; // ponytail: one page of a Project's linked repositories; a Project with more offers its first 100 (#846)

// The settings form's filter criteria (#245): the project's fields, of which only the single-select ones answer a name and options.
export const SELECT_FIELDS = `query($login: String!, $number: Int!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        fields(first: ${FIELD_LIMIT}) { nodes { ... on ProjectV2SingleSelectField { name options { name } } } }
        repositories(first: ${REPOSITORY_LIMIT}) { nodes { nameWithOwner } }
      }
    }
  }
}`;

// `rateLimit` costs nothing extra on a query already being paid for: the poll's own quota reading. The task filter reads assignees, labels,
// milestone and repository here, and each item's set field values with their field's name, single-select or text (#245); together about two
// rate-limit points per page. A dynamic source's rules read those same field values by name (#293): the query never grows for them.
// Each issue also carries its node id and its sub-issues' node ids (epic order) and states, so listItems can queue an epic's children right after it (#211) and link every item to its parent and children (#28).
export const ITEMS = `query($login: String!, $number: Int!, $after: String, $filter: String) {
  rateLimit { limit remaining resetAt }
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        items(first: ${PAGE_SIZE}, after: $after, query: $filter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            updatedAt
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            fieldValues(first: ${FIELD_VALUE_LIMIT}) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
              }
            }
            content { __typename ... on Issue { id number title body url createdAt subIssuesSummary { total } subIssues(first: ${SUB_ISSUE_LIMIT}) { nodes { id state } } assignees(first: ${ASSIGNEE_LIMIT}) { nodes { login } } labels(first: ${LABEL_LIMIT}) { nodes { name } } milestone { title } repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

// #190, #189 §5: the poll's probe, 1 point. A project's updatedAt moves on an item's field write and a content edit; the rateLimit keeps the
// source's quota reading fresh on a poll that reads nothing more
export const PROBE = `query($login: String!, $number: Int!) {
  rateLimit { limit remaining resetAt }
  repositoryOwner(login: $login) { ... on ProjectV2Owner { projectV2(number: $number) { updatedAt } } }
}`;

// Each set value of an item with its field's name, of every kind the native view renders (#756); ITEM_FIELDS reads the same (#686)
const ALL_FIELD_VALUES = `fieldValues(first: ${FIELD_VALUE_LIMIT}) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
              }
            }`;

// The native view (#756): the project's fields with their kind and their options or iterations (what the view groups by), then every item with each set value under its field's name, of every kind
// the view renders, and on an issue what its row shows: body, labels, assignees, repository and milestone (the filter's facets), its
// sub-issues' progress and the PRs that close it, merged or closed included, with their checks' rollup. A PR that only mentions the issue
// is not in closedByPullRequestsReferences. Its dates, parent and issue type are read off the issue itself, as are its milestone and
// repository: one read whatever field kinds the project lists (addendum 2). Its blocked-by relations ride along (#61): the table's blocked-by column.
export const PROJECT_ITEMS = `query($login: String!, $number: Int!, $after: String) {
  rateLimit { limit remaining resetAt }
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        fields(first: ${FIELD_LIMIT}) { nodes { ... on ProjectV2FieldCommon { name dataType } ... on ProjectV2SingleSelectField { options { name } } ... on ProjectV2IterationField { configuration { iterations { title } } } } }
        items(first: ${PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            ${ALL_FIELD_VALUES}
            content { __typename ... on Issue { number title body url createdAt updatedAt closedAt parent { number title } issueType { name } subIssuesSummary { completed total } assignees(first: ${ASSIGNEE_LIMIT}) { nodes { login } } labels(first: ${LABEL_LIMIT}) { nodes { name } } milestone { title } repository { nameWithOwner } blockedBy(first: ${RELATION_LIMIT}) { ${BLOCKER_NODES} } closedByPullRequestsReferences(first: ${PROJECT_PR_LIMIT}, includeClosedPrs: true) { nodes { number url state merged statusCheckRollup { state } } } } }
          }
        }
      }
    }
  }
}`;

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

// One item's fields for its editors (#686), by its project item id. It reads:
// - the project's fields with their ids, options and iterations: what a name resolves against;
// - the item's values, as PROJECT_ITEMS reads them;
// - the issue, as both the poll (ITEMS) and the native view read it, with its blocked-by relations (#61), so the re-read is a row and an entry
//   and a write's row keeps the blocked-by cell;
// - what the issue's own fields can be: the repository's assignable users, labels, open milestones and issue types.
// Read before a write and again after it.
export const ITEM_FIELDS = `query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      id
      updatedAt
      project { id fields(first: ${FIELD_LIMIT}) { nodes { ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } ... on ProjectV2IterationField { configuration { iterations { id title } } } } } }
      fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      ${ALL_FIELD_VALUES}
      content { __typename ... on Issue { id number title body url createdAt updatedAt closedAt parent { number title } issueType { id name } subIssuesSummary { completed total } subIssues(first: ${SUB_ISSUE_LIMIT}) { nodes { id state } } assignees(first: ${ASSIGNEE_LIMIT}) { nodes { id login } } labels(first: ${LABEL_LIMIT}) { nodes { id name } } milestone { id title } closedByPullRequestsReferences(first: ${PROJECT_PR_LIMIT}, includeClosedPrs: true) { nodes { number url state merged statusCheckRollup { state } } } blockedBy(first: ${RELATION_LIMIT}) { ${BLOCKER_NODES} } repository { nameWithOwner assignableUsers(first: ${ASSIGNABLE_LIMIT}) { nodes { id login } } labels(first: ${REPO_LABEL_LIMIT}) { nodes { id name } } milestones(first: ${MILESTONE_LIMIT}, states: [OPEN]) { nodes { id title } } issueTypes(first: ${ISSUE_TYPE_LIMIT}) { nodes { id name } } } } }
    }
  }
}`;

export const VIEWER = 'query { viewer { login } }';

// The source actions beyond a move (#286): the two item mutations take the project and the item, the two issue ones the issue's node id.
export const ARCHIVE_ITEM = `mutation($projectId: ID!, $itemId: ID!) {
  archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
}`;
export const DELETE_ITEM = `mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
}`;
// stateReason and duplicateIssueId come from hive_stop (#314); a close from onFinish leaves both out, which GitHub reads as completed.
export const CLOSE_ISSUE = `mutation($issueId: ID!, $stateReason: IssueClosedStateReason, $duplicateIssueId: ID) {
  closeIssue(input: { issueId: $issueId, stateReason: $stateReason, duplicateIssueId: $duplicateIssueId }) { issue { id } }
}`;
export const DELETE_ISSUE = `mutation($issueId: ID!) {
  deleteIssue(input: { issueId: $issueId }) { clientMutationId }
}`;
// hive_stop's duplicate (#314): the original's node id, by number, in the closed issue's own repository.
export const ISSUE_ID = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
}`;

// #57: the blockers add row's search. The whole search string (`repo:<owner/name> is:issue in:title <text>`) is the $q variable: what the user
// types never becomes part of this text
export const SEARCH_ISSUES = `query($q: String!) {
  search(type: ISSUE, first: 8, query: $q) { nodes { ... on Issue { number title state repository { nameWithOwner } } } }
}`;

// A decomposition's write (#865): the repository the issues are created in, each issue, its project item, its parent and its blockers.
// Every value travels as a variable through cliGqlJson's stdin, never in the query's text.
export const REPOSITORY_ID = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id }
}`;
export const CREATE_ISSUE = `mutation($repositoryId: ID!, $title: String!, $body: String!, $labelIds: [ID!]) {
  createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, labelIds: $labelIds }) { issue { id number url } }
}`; // url: #846 names it when the Project write fails after the issue exists; labelIds: a decomposition's label (#936), none when not sent
// A decomposition's write and delivery (#936): a repository's node id, and its default branch, which the Design: links and the PR's base name
export const REPOSITORY_BRANCH = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id defaultBranchRef { name } }
}`;
// A decomposition's label (#936): found by name, else created in the repository
export const REPOSITORY_LABEL = `query($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) { label(name: $label) { id } }
}`;
export const CREATE_LABEL = `mutation($repositoryId: ID!, $name: String!, $color: String!) {
  createLabel(input: { repositoryId: $repositoryId, name: $name, color: $color }) { label { id } }
}`;
// A decomposition's PR (#936): the file's branch to its repository's default branch, with the Hive's own login
export const CREATE_PULL_REQUEST = `mutation($repositoryId: ID!, $baseRefName: String!, $headRefName: String!, $title: String!, $body: String!) {
  createPullRequest(input: { repositoryId: $repositoryId, baseRefName: $baseRefName, headRefName: $headRefName, title: $title, body: $body }) { pullRequest { number url } }
}`;
// The open PRs of a head and base (#936): when GitHub refuses a second one, the one from the repository itself is the one to record; a fork's
// PR of the same branch name matches headRefName too, so its head repository comes with it
export const OPEN_PULL_REQUEST = `query($owner: String!, $name: String!, $head: String!, $base: String!) {
  repository(owner: $owner, name: $name) { pullRequests(headRefName: $head, baseRefName: $base, states: OPEN, first: 10) { nodes { number headRepository { nameWithOwner } } } }
}`;
// An issue already in the project answers its existing item: a replay is harmless
export const ADD_PROJECT_ITEM = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;
export const ADD_SUB_ISSUE = `mutation($issueId: ID!, $subIssueId: ID!) {
  addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { id } }
}`;
export const ADD_BLOCKED_BY = `mutation($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } }
}`;
// #56: a relation's removal, its sides as addBlockedBy's: the blocked issue, then the one blocking it
export const REMOVE_BLOCKED_BY = `mutation($issueId: ID!, $blockingIssueId: ID!) {
  removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } }
}`;

// One task's issue comments, asked by the project item id the Hive already holds: no owner, repo or number to rebuild.
// A draft or a pull request matches no fragment and answers an empty content.
export const COMMENTS = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      content { ... on Issue { comments(first: ${COMMENT_LIMIT}) { nodes { author { login } createdAt body url } } } }
    }
  }
}`;

export interface GhProject { number: number; title: string; url: string; closed?: boolean }
export interface GhOption { id: string; name: string }
export interface GhIssueRef { number: number; state: string }
/** The other issue of a blocker relation (#56): what a BlockerRef shows of it, and its repository, which decides whether its id is short. */
export interface GhBlockerRef extends GhIssueRef { title: string; repository: { nameWithOwner: string } }
export interface GhIssueRelations { blockedBy?: { nodes: GhBlockerRef[] } | null; blocking?: { nodes: GhBlockerRef[] } | null; subIssues?: { nodes: GhIssueRef[] } | null }
export interface GhRateLimit { limit?: unknown; remaining?: unknown; resetAt?: unknown }
/** One set field value of an item and its field's name (#245, #756): a single-select answers name, a text field text, a number number, a
 * date date (ISO day), an iteration title; ITEMS asks only the first two, so any other kind answers {} there. */
export interface GhFieldValue { name?: string; text?: string; number?: number; date?: string; title?: string; field?: { name?: string } | null }
export interface GhItemNode {
  id: string;
  updatedAt?: string; // the item's own (#190): the read model's replace rule compares it; a field write and a content edit move it (#189 §3)
  fieldValueByName?: { name?: string } | null;
  fieldValues?: { nodes: GhFieldValue[] } | null;
  content?: {
    __typename?: string; id?: string; number?: number; title?: string; body?: string | null; url?: string; createdAt?: string;
    subIssuesSummary?: { total: number; completed?: number } | null;
    subIssues?: { nodes: { id: string; state: 'OPEN' | 'CLOSED' }[] } | null; // node ids and states, the issue's own order: what groupUnderEpics groups by (#211) and treeLinks links (#28)
    assignees?: { nodes: { id?: string; login: string }[] } | null; labels?: { nodes: { id?: string; name: string }[] } | null; milestone?: { id?: string; title: string } | null;
    repository?: ({ nameWithOwner: string } & GhIssueChoices) | null; // owner/name: what a repository rule matches (#245); the choices: ITEM_FIELDS only (#686)
    closedByPullRequestsReferences?: { nodes: GhPullRequest[] } | null; // PROJECT_ITEMS only (#756)
    blockedBy?: { nodes: GhBlockerRef[] } | null; // PROJECT_ITEMS and ITEM_FIELDS (#61): the blocked-by column
    updatedAt?: string; closedAt?: string | null; parent?: { number: number; title: string } | null; issueType?: { id?: string; name: string } | null; // PROJECT_ITEMS only
  } | null;
}

/** A PR that closes an issue (#756): state OPEN, CLOSED or MERGED; the rollup's state SUCCESS, FAILURE, ERROR, PENDING or EXPECTED. */
export interface GhPullRequest { number: number; url: string; state?: string; merged?: boolean; isDraft?: boolean; statusCheckRollup?: { state?: string } | null }
/** A project field as PROJECT_ITEMS answers it (#756): its name and GitHub's ProjectV2FieldType, a single-select's options and an
 * iteration field's active and upcoming iterations; a field it cannot read answers {}. */
export interface GhProjectField {
  id?: string; // ITEM_FIELDS only (#686): what a write names the field by
  name?: string; dataType?: string; options?: { id?: string; name: string }[]; configuration?: { iterations?: { id?: string; title: string }[] } | null;
}

export interface ProjectsData { repositoryOwner?: { projectsV2?: { nodes?: GhProject[] } } | null }
export interface FieldsData {
  repositoryOwner?: { projectV2?: { id: string; field?: { id: string; options: GhOption[] } | null } | null } | null;
}
/** A project field as SELECT_FIELDS answers it (#245): a field of another kind answers {}. */
export interface GhSelectField { name?: string; options?: { name: string }[] }
export interface SelectFieldsData {
  repositoryOwner?: { projectV2?: { fields?: { nodes: GhSelectField[] } | null; repositories?: { nodes: { nameWithOwner: string }[] } | null } | null } | null; // repositories: #846
}

export interface ItemsData {
  rateLimit?: GhRateLimit | null;
  repositoryOwner?: {
    projectV2?: {
      fields?: { nodes: GhProjectField[] } | null; // PROJECT_ITEMS only (#756)
      items: { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: GhItemNode[] };
    } | null;
  } | null;
}

/** PROBE's answer (#190): a null owner or project is the source not being there. */
export interface ProbeData { rateLimit?: GhRateLimit | null; repositoryOwner?: { projectV2?: { updatedAt: string } | null } | null }
// One entry per alias; the repository (null) or the issue (issue: null) may be gone by the time we ask.
export type RelationsData = Record<string, { issue: GhIssueRelations | null } | null | undefined>;
export interface ViewerData { viewer?: { login?: string } | null }
export interface GhComment { author?: { login?: string } | null; createdAt: string; body: string; url: string }
export interface CommentsData { node?: { content?: { comments?: { nodes: GhComment[] } | null } | null } | null }
export interface IssueIdData { repository?: { issue?: { id: string } | null } | null }
export interface SearchIssuesData { search?: { nodes: Partial<GhBlockerRef>[] } | null } // #57: a node that is no issue answers {}
export interface CreateIssueData { createIssue?: { issue?: { id: string; number: number; url: string } | null } | null } // #865
export interface AddProjectItemData { addProjectV2ItemById?: { item?: { id: string } | null } | null } // #865
export interface RepositoryLabelData { repository?: { label?: { id: string } | null } | null } // #936
export interface CreateLabelData { createLabel?: { label?: { id: string } | null } | null } // #936
export interface RepositoryBranchData { repository?: { id: string; defaultBranchRef?: { name: string } | null } | null } // #936
export interface OpenPullRequestData { repository?: { pullRequests?: { nodes?: { number: number; headRepository?: { nameWithOwner?: string } | null }[] } | null } | null } // #936
export interface CreatePullRequestData { createPullRequest?: { pullRequest?: { number: number; url: string } | null } | null } // #936

/** What an issue's own fields can be (#686), read off its repository by ITEM_FIELDS only. */
export interface GhIssueChoices {
  assignableUsers?: { nodes: { id: string; login: string }[] } | null;
  labels?: { nodes: { id: string; name: string }[] } | null;
  milestones?: { nodes: { id: string; title: string }[] } | null;
  issueTypes?: { nodes: { id: string; name: string }[] } | null;
}
/** One project item as ITEM_FIELDS answers it (#686): an item node with its project's fields; a node that is no project item answers {}. */
export type GhItemFieldsNode = GhItemNode & { project?: { id: string; fields?: { nodes: GhProjectField[] } | null } | null };
export interface ItemFieldsData { node?: GhItemFieldsNode | null }

// owner / name / number come from the issue url; they match only [\w.-], so JSON.stringify yields safe GraphQL string literals.
function issueSelection(item: Item, alias: string): string | undefined {
  const match = ISSUE_URL.exec(item.url);
  if (!match) return undefined;
  const [, owner, name, number] = match;
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issue(number: ${number}) {`
    + ` blockedBy(first: ${RELATION_LIMIT}) { ${BLOCKER_NODES} }`
    + ` blocking(first: ${RELATION_LIMIT}) { ${BLOCKER_NODES} }`
    + ` subIssues(first: ${RELATION_LIMIT}) { nodes { number state } } } }`;
}

/** One query for the whole queue: alias i<k> is the k-th task. Nothing to ask → undefined (no call). */
export function relationsQuery(items: Item[]): string | undefined {
  const selections = items.flatMap((item, i) => issueSelection(item, `i${i}`) ?? []);
  return selections.length > 0 ? `query { ${selections.join(' ')} }` : undefined;
}

/** An issue's repository, from its url (#314); anything but an issue url → undefined. */
export function issueRepo(url: string): { owner: string; name: string } | undefined {
  const match = ISSUE_URL.exec(url);
  return match ? { owner: match[1], name: match[2] } : undefined;
}
