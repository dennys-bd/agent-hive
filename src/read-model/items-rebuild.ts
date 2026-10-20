import { STATUS } from '../field-values.js';
import type { GhBlockerRef, GhIssueRelations, GhItemFieldsNode, GhItemNode, GhProjectField, GhPullRequest, GhSubIssue } from '../sources/github-queries.js';
import type { ProjectPr, Signal } from '../types.js';
import type { ReadModel, ScopeKind } from './db.js';
import type { FieldValueRow, IssueDetails, IssueRow, ProjectFieldRow, RelationRow, StoredItemRows } from './rows.js';

// The rows back into the node the poll's steps and the views read (#282). The contract test compares the consumers' answers over this node and
// the wire's, not the nodes: a key no consumer reads (a draft's title, a PR item's fields) is not rebuilt
type Content = NonNullable<GhItemNode['content']>;
const ROLLUP: Record<Signal, string> = { green: 'SUCCESS', red: 'FAILURE', yellow: 'PENDING' };
const PR_STATE: Record<ProjectPr['state'], string> = { open: 'OPEN', merged: 'MERGED', closed: 'CLOSED' };

// A stored PR back to a node pullRequest() maps to the same ProjectPr
const pullRequestOf = (pr: ProjectPr): GhPullRequest => ({
  number: pr.number, url: pr.url, state: PR_STATE[pr.state], merged: pr.state === 'merged', isDraft: pr.draft === true,
  statusCheckRollup: pr.checks === undefined ? null : { state: ROLLUP[pr.checks] },
});
const refOf = (r: RelationRow): GhBlockerRef => ({ number: r.number ?? 0, title: r.title ?? '', state: r.state, repository: { nameWithOwner: r.repository ?? '' } });
const subIssueOf = (r: RelationRow): GhSubIssue => ({
  id: r.nodeId ?? '', state: r.state === 'CLOSED' ? 'CLOSED' : 'OPEN', ...(r.number === null ? {} : { number: r.number }),
  ...(r.title === null ? {} : { title: r.title }), ...(r.repository === null ? {} : { repository: { nameWithOwner: r.repository } }),
});
const fieldValueOf = (v: FieldValueRow) => ({ [v.kind]: v.kind === 'number' ? Number(v.value) : v.value, field: { name: v.field } });

function issueContent(rows: StoredItemRows, issue: IssueRow, details: IssueDetails): Content {
  const of = (kind: RelationRow['kind']): RelationRow[] => rows.relations.filter((r) => r.kind === kind);
  return {
    __typename: 'Issue', id: issue.nodeId, number: issue.number, title: issue.title, body: issue.body, url: details.url,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED', author: issue.author === null ? null : { login: issue.author }, comments: { totalCount: issue.comments },
    createdAt: issue.createdAt, updatedAt: issue.updatedAt, closedAt: issue.closedAt,
    assignees: { nodes: issue.assignees.map((login) => ({ login })) }, labels: { nodes: issue.labels.map((name) => ({ name })) },
    milestone: details.milestone === null ? null : { title: details.milestone }, issueType: details.issueType === null ? null : { name: details.issueType },
    parent: details.parentNumber === null ? null : { number: details.parentNumber, title: details.parentTitle ?? '' },
    subIssuesSummary: details.subIssuesTotal === null ? null : { total: details.subIssuesTotal, completed: details.subIssuesCompleted ?? 0 },
    subIssues: { nodes: of('subIssue').map(subIssueOf) }, blockedBy: { nodes: of('blockedBy').map(refOf) },
    closedByPullRequestsReferences: { nodes: rows.pullRequests.map(pullRequestOf) }, repository: { nameWithOwner: issue.repository },
  };
}

// An issue item whose issues row is gone (the REST reconcile removed it) has no content: the next full read drops the item too
function contentOf(rows: StoredItemRows): GhItemNode['content'] {
  const type = rows.item.contentType;
  if (type === null) return null;
  if (type !== 'Issue') return { __typename: type };
  return rows.issue === undefined || rows.details === undefined ? null : issueContent(rows, rows.issue, rows.details);
}

/** The rows back into the node listed() and projectItem() read (#282): the contract test's subject. */
export function rebuildNode(rows: StoredItemRows): GhItemNode {
  const status = rows.values.find((v) => v.field === STATUS);
  return {
    id: rows.item.nodeId, updatedAt: rows.item.updatedAt, fieldValueByName: status === undefined ? null : { name: status.value },
    fieldValues: { nodes: rows.values.map(fieldValueOf) }, content: contentOf(rows),
  };
}

/** What the relations query answered of the item (#190's three states): undefined never read, null the issue is gone, else its blocking. */
export function blockingOf(rows: StoredItemRows): GhIssueRelations | null | undefined {
  const read = rows.item.blockingRead;
  if (read === null) return undefined;
  return read === 0 ? null : { blocking: { nodes: rows.relations.filter((r) => r.kind === 'blocking').map(refOf) } };
}

/** The stored fields back into the shape projectFields(), projectBuiltins() and itemFields() read (#282): options or iterations by name. */
export const rebuildFields = (rows: ProjectFieldRow[]): GhProjectField[] => rows.map((f) => ({
  name: f.name, ...(f.dataType === null ? {} : { dataType: f.dataType }),
  ...(f.options === null ? {} : f.dataType === 'ITERATION' ? { configuration: { iterations: f.options.map((title) => ({ title })) } } : { options: f.options.map((name) => ({ name })) }),
}));

const ownerOf = (repository: string): string => repository.slice(0, repository.indexOf('/'));
const isSynced = (db: ReadModel, source: string, key: string, kind: ScopeKind): boolean => typeof db.scope(source, key, kind)?.syncedAt === 'string';
// Only a synced scope says what the options are: an empty table then is "none", not "not stored" (#282)
const optionsStored = (db: ReadModel, source: string, repository: string): boolean =>
  (['labels', 'assignees', 'milestones'] as const).every((kind) => isSynced(db, source, repository, kind)) && isSynced(db, source, ownerOf(repository), 'issueTypes');

/** The editor's node (#282): rebuildNode with the Project's fields and the repository's options; undefined when the item is not this Project's,
 * is no issue, or its options were never synced, and the editor reads live. The ids are empty: a write never resolves against this node, it reads
 * ITEM_FIELDS live. */
export function rebuildFieldsNode(db: ReadModel, source: string, project: string, itemId: string): GhItemFieldsNode | undefined {
  const [rows] = db.itemRows(source, [itemId]);
  const repository = rows?.issue?.repository;
  if (rows === undefined || rows.item.project !== project || repository === undefined || !optionsStored(db, source, repository)) return undefined;
  const node = rebuildNode(rows);
  if (!node.content) return undefined;
  const choices = {
    assignableUsers: { nodes: db.assignees(source, repository).map((login) => ({ id: '', login })) },
    labels: { nodes: db.labels(source, repository).map((name) => ({ id: '', name })) },
    milestones: { nodes: db.milestones(source, repository).map((title) => ({ id: '', title })) },
    issueTypes: { nodes: db.issueTypes(source, ownerOf(repository)).map((name) => ({ id: '', name })) },
  };
  return { ...node, project: { id: '', fields: { nodes: rebuildFields(db.projectFields(source, project)) } }, content: { ...node.content, repository: { nameWithOwner: repository, ...choices } } };
}
