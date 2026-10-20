import { STATUS } from '../field-values.js';
import type { GhBlockerRef, GhIssueRelations, GhItemNode, GhProjectField } from '../sources/github-queries.js';
import type { ReadModel, SyncKind } from './db.js';
import { blockingOf, rebuildNode } from './items-rebuild.js';
import { closingPrsFromGql, issueFromGql, WireError } from './normalize.js';
import type { FieldValueRow, IssueDetails, NormalizedItem, ProjectFieldRow, RelationRow, UpsertOrigin } from './rows.js';

// A Project's items (#190), normalized (#282): what one wire node becomes in the read model's tables. items-rebuild.ts turns them back;
// listed(), projectItem() and itemFields() run unchanged over the rebuilt node (items-contract.test.ts)

/** What the adapter needs of the model (#190): the rows' source, the database, and the readModel event a write's issue row names (#282). */
export interface ItemStore { db: ReadModel; source(): Promise<string | undefined>; notify(repository: string, kinds: SyncKind[]): void }
/** One listing (#282): the reading account and the Project (`<owner login>/<number>`). The read is unfiltered, so sources over one Project share it. */
export interface ListingKey { source: string; project: string }
/** One full read (#282): the Project's fields and its items in order. */
export interface ItemsRead { nodes: GhItemNode[]; fields: GhProjectField[] }
/** A listing as stored: the rebuilt nodes in order, each with what the relations query answered of it (undefined never read, null gone). */
export interface StoredListing { nodes: GhItemNode[]; relations: Map<string, GhIssueRelations | null | undefined> }

type Content = NonNullable<GhItemNode['content']>;
const VALUE_KINDS = ['name', 'text', 'number', 'date', 'title'] as const;

// One row per field. Status is stored as any single-select: past FIELD_VALUE_LIMIT fieldValues may lack it while fieldValueByName names it
function valuesOf(node: GhItemNode): FieldValueRow[] {
  const rows = new Map<string, FieldValueRow>();
  for (const v of node.fieldValues?.nodes ?? []) {
    const kind = VALUE_KINDS.find((k) => v[k] !== undefined);
    if (v.field?.name !== undefined && kind !== undefined) rows.set(v.field.name, { field: v.field.name, kind, value: String(v[kind]) });
  }
  const status = node.fieldValueByName?.name;
  if (status !== undefined && !rows.has(STATUS)) rows.set(STATUS, { field: STATUS, kind: 'name', value: status });
  return [...rows.values()];
}

const refRow = (kind: 'blockedBy' | 'blocking') => (ref: GhBlockerRef): RelationRow =>
  ({ kind, nodeId: null, number: ref.number, title: ref.title, state: ref.state, repository: ref.repository.nameWithOwner });

// The items read's own relations, read for every issue item, so "none" is no rows
function relationRowsOf(c: Content): RelationRow[] {
  const subIssues = (c.subIssues?.nodes ?? []).map((s): RelationRow => ({
    kind: 'subIssue', nodeId: s.id, number: s.number ?? null, title: s.title ?? null, state: s.state, repository: s.repository?.nameWithOwner ?? null,
  }));
  return [...(c.blockedBy?.nodes ?? []).map(refRow('blockedBy')), ...subIssues];
}

/** The relations query's answer as rows (#282): its blocking side; null stays null, the issue is gone. */
export const blockingRows = (issue: GhIssueRelations | null): RelationRow[] | null => (issue === null ? null : (issue.blocking?.nodes ?? []).map(refRow('blocking')));

function detailsOf(c: Content): IssueDetails {
  if (typeof c.url !== 'string') throw new WireError('url');
  return {
    url: c.url, milestone: c.milestone?.title ?? null, issueType: c.issueType?.name ?? null, parentNumber: c.parent?.number ?? null,
    parentTitle: c.parent?.title ?? null, subIssuesTotal: c.subIssuesSummary?.total ?? null, subIssuesCompleted: c.subIssuesSummary?.completed ?? null,
  };
}

/** The normalizer (#282): a poll's node or a write's re-read (GhItemFieldsNode extends GhItemNode) as the rows it becomes. An issue the wire
 * answered malformed throws WireError: the caller normalizes before its transaction, so nothing is stored. */
export function normalizeItem(source: string, project: string, node: GhItemNode): NormalizedItem {
  const c = node.content;
  // both queries ask updatedAt; a node without it ties with every other, and the write window still decides
  const item = { source, nodeId: node.id, project, contentType: c?.__typename ?? null, issueNodeId: null, updatedAt: node.updatedAt ?? '' };
  const values = valuesOf(node);
  if (c?.__typename !== 'Issue') return { item, values, pullRequests: [] };
  const repository = c.repository?.nameWithOwner;
  if (repository === undefined) throw new WireError('repository');
  const issue = issueFromGql(source, repository, c);
  const pullRequests = c.closedByPullRequestsReferences ? closingPrsFromGql(c) : [];
  return { item: { ...item, issueNodeId: issue.nodeId }, values, issue, details: detailsOf(c), pullRequests, relations: relationRowsOf(c) };
}

/** The Project's named fields as project_fields keeps them (#282); a field GitHub could not read ({}) is not one. */
export const fieldRowsOf = (fields: GhProjectField[]): ProjectFieldRow[] => fields.flatMap((f) => (f.name === undefined ? [] : [{
  name: f.name, dataType: f.dataType ?? null, options: f.options?.map((o) => o.name) ?? f.configuration?.iterations?.map((i) => i.title) ?? null,
}]));

/** One normalized item written (#282): the item under the replace rule, and its values and content type only when that wrote, so a page read
 * before a write cannot undo the write through a side table. Its relations (blockedBy, subIssue) are replaced on every read, as #190's
 * relations were: a blocker or a sub-issue closing does not move the item's updatedAt, so under the item's rule they would never refresh.
 * Its issues row under its own rule, its details on that row's terms, its closing PRs replaced whole (the last of their two writers wins).
 * Whether its issues row wrote. */
export function writeItem(db: ReadModel, n: NormalizedItem, origin: UpsertOrigin): boolean {
  const { source, nodeId } = n.item;
  if (db.upsertItem(n.item, origin)) db.setItemValues(source, nodeId, n.values);
  if (n.issue !== undefined && n.relations !== undefined) db.setIssueRelations(source, n.issue.nodeId, ['blockedBy', 'subIssue'], n.relations);
  if (n.issue === undefined) return false;
  const wrote = db.upsertIssue(n.issue, origin);
  if (n.details !== undefined) db.setIssueDetails(source, n.issue.nodeId, n.issue.updatedAt, n.details, origin);
  db.setClosingPrs(source, n.issue.nodeId, n.pullRequests);
  return wrote;
}

/** One full read stored (#282), in one transaction: every item, then the blocking the relations query answered, the Project's fields, the
 * listing replaced, the items it no longer names removed. Normalized first: a malformed node stores nothing. */
export function storeListing(db: ReadModel, key: ListingKey, read: ItemsRead, blocking: ReadonlyMap<string, GhIssueRelations | null>): void {
  const items = read.nodes.map((node) => normalizeItem(key.source, key.project, node));
  db.transaction(() => {
    for (const item of items) writeItem(db, item, 'sync');
    for (const [nodeId, issue] of blocking) db.setBlocking(key.source, nodeId, blockingRows(issue));
    db.setProjectFields(key.source, key.project, fieldRowsOf(read.fields));
    db.setListing(key.source, key.project, read.nodes.map((node) => node.id));
    db.removeUnlisted(key.source, key.project);
  });
}

/** The listing as stored, rebuilt in position order, each node with what the relations query answered of it. */
export function readListing(db: ReadModel, key: ListingKey): StoredListing {
  const rows = db.itemRows(key.source, db.listing(key.source, key.project));
  return { nodes: rows.map(rebuildNode), relations: new Map(rows.map((r) => [r.item.nodeId, blockingOf(r)])) };
}

/** Whether a full read was stored for the Project (#282): every Project has fields (Title, Status…), so none stored is none read. */
export const hasListing = (db: ReadModel, key: ListingKey): boolean => db.projectFields(key.source, key.project).length > 0;
