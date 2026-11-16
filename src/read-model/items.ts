import { STATUS } from '../field-values.js';
import type { GhBlockerRef, GhIssueRelations, GhItemNode, GhProjectField } from '../sources/github-queries.js';
import type { ReadModel, SyncKind } from './db.js';
import type { RefetchOutcome } from './loop.js';
import { blockingOf, rebuildNode } from './items-rebuild.js';
import { closingPrsFromGql, issueFromGql, WireError } from './normalize.js';
import type { IssueDetails, NormalizedItem, UpsertOrigin } from './rows.js';
import type { SourceField, SourceItem, SourceItemValue, SourceRelation } from './source-items.js';

// A Project's items (#190), normalized (#282): what one wire node becomes in the read model's tables. items-rebuild.ts turns them back;
// listed(), projectItem() and itemFields() run unchanged over the rebuilt node (items-contract.test.ts)

/** What the adapter needs of the model (#190): the rows' source, the database, the readModel event a write's issue row names (#282) and,
 * #567, the refetch of one issue past the Project, which stores it as an issue page's refetch does. */
export interface ItemStore {
  db: ReadModel; source(): Promise<string | undefined>; notify(repository: string, kinds: SyncKind[]): void;
  refetch(repository: string, number: number): Promise<RefetchOutcome>;
}
/** One listing (#282): the reading account and the Project (`<owner login>/<number>`). The read is unfiltered, so sources over one Project share it. */
export interface ListingKey { source: string; project: string }
/** One full read (#282): the Project's fields and its items in order. */
export interface ItemsRead { nodes: GhItemNode[]; fields: GhProjectField[] }
/** A listing as stored: the rebuilt nodes in order, each with what the relations query answered of it (undefined never read, null gone). */
export interface StoredListing { nodes: GhItemNode[]; relations: Map<string, GhIssueRelations | null | undefined> }

type Content = NonNullable<GhItemNode['content']>;
const VALUE_KINDS = ['name', 'text', 'number', 'date', 'title'] as const; // the GhFieldValue keys
// The GhFieldValue key that holds a value, as the neutral store's kind (#833); items-rebuild.ts maps it back
const KIND_OF: Record<(typeof VALUE_KINDS)[number], SourceItemValue['kind']> = { name: 'option', text: 'text', number: 'number', date: 'date', title: 'iteration' };
// blockedBy and subItem come with the items read, blocking with the relations query: each writer replaces only its own kinds
const ITEM_READ_KINDS: readonly SourceRelation['kind'][] = ['blockedBy', 'subItem'];
const BLOCKING_KINDS: readonly SourceRelation['kind'][] = ['blocking'];

// One row per field. Status is stored as any single-select: past FIELD_VALUE_LIMIT fieldValues may lack it while fieldValueByName names it
function valuesOf(node: GhItemNode): SourceItemValue[] {
  const rows = new Map<string, SourceItemValue>();
  for (const v of node.fieldValues?.nodes ?? []) {
    const kind = VALUE_KINDS.find((k) => v[k] !== undefined);
    if (v.field?.name !== undefined && kind !== undefined) rows.set(v.field.name, { field: v.field.name, kind: KIND_OF[kind], value: String(v[kind]) });
  }
  const status = node.fieldValueByName?.name;
  if (status !== undefined && !rows.has(STATUS)) rows.set(STATUS, { field: STATUS, kind: 'option', value: status });
  return [...rows.values()];
}

// A target's key is how the Hive names an issue, <owner>/<repo>#<number>; with either part missing there is none
const targetKey = (repository: string | null | undefined, number: number | null | undefined): string | null =>
  (repository == null || number == null ? null : `${repository}#${number}`);
const refRow = (kind: 'blockedBy' | 'blocking') => (ref: GhBlockerRef): SourceRelation =>
  ({ kind, targetId: null, targetKey: targetKey(ref.repository.nameWithOwner, ref.number), title: ref.title, state: ref.state });

// The items read's own relations, read for every issue item, so "none" is no rows
function relationRowsOf(c: Content): SourceRelation[] {
  const subIssues = (c.subIssues?.nodes ?? []).map((s): SourceRelation => ({
    kind: 'subItem', targetId: s.id, targetKey: targetKey(s.repository?.nameWithOwner, s.number), title: s.title ?? null, state: s.state,
  }));
  return [...(c.blockedBy?.nodes ?? []).map(refRow('blockedBy')), ...subIssues];
}

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
  const values = valuesOf(node);
  // both queries ask updatedAt; a node without it ties with every other, and the write window still decides
  const item: SourceItem = {
    source, nodeId: node.id, scope: project, key: node.id, updatedAt: node.updatedAt ?? '', valuesSig: JSON.stringify([...values].sort((a, b) => (a.field < b.field ? -1 : 1))),
    parentId: null, parentKey: null, parentTitle: null, contentId: null, data: { contentType: c?.__typename ?? null },
  };
  if (c?.__typename !== 'Issue') return { item, values, pullRequests: [] };
  const repository = c.repository?.nameWithOwner;
  if (repository === undefined) throw new WireError('repository');
  const issue = issueFromGql(source, repository, c);
  const pullRequests = c.closedByPullRequestsReferences ? closingPrsFromGql(c) : [];
  // the parent stays on the issues row (parent_number, parent_title): one parent in two places could disagree
  return { item: { ...item, key: `${repository}#${issue.number}`, contentId: issue.nodeId }, values, issue, details: detailsOf(c), pullRequests, relations: relationRowsOf(c) };
}

/** The Project's named fields as source_fields keeps them (#282, #833): dataType as kind; a field GitHub could not read ({}) is not one. */
export const fieldRowsOf = (fields: GhProjectField[]): SourceField[] => fields.flatMap((f) => (f.name === undefined ? [] : [{
  name: f.name, kind: f.dataType ?? null, options: f.options?.map((o) => o.name) ?? f.configuration?.iterations?.map((i) => i.title) ?? null,
}]));

/** What the relations query answered of one item (#190's three states, #833): its blocking rows and the marker. A gone issue (null) clears the
 * rows and marks false. The callers hold the transaction. */
export function writeBlocking(db: ReadModel, source: string, nodeId: string, issue: GhIssueRelations | null): void {
  db.items.setRelations(source, nodeId, issue === null ? [] : (issue.blocking?.nodes ?? []).map(refRow('blocking')), BLOCKING_KINDS);
  db.items.setRelationsRead(source, nodeId, issue !== null);
}

/** One normalized item written (#282): the item under the replace rule, and its values only when that wrote, so a page read before a write
 * cannot undo the write through a side table. Its relations (blockedBy, subItem) are replaced on every read, as #190's relations were: a
 * blocker or a sub-issue closing does not move the item's updatedAt, so under the item's rule they would never refresh.
 * Its issues row under its own rule, its details on that row's terms, its closing PRs replaced whole (the last of their two writers wins).
 * Whether its issues row wrote. */
export function writeItem(db: ReadModel, n: NormalizedItem, origin: UpsertOrigin): boolean {
  const { source, nodeId } = n.item;
  if (db.items.upsertItem(n.item, origin)) db.items.setValues(source, nodeId, n.values);
  if (n.relations !== undefined) db.items.setRelations(source, nodeId, n.relations, ITEM_READ_KINDS);
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
    for (const [nodeId, issue] of blocking) writeBlocking(db, key.source, nodeId, issue);
    db.items.setFields(key.source, key.project, fieldRowsOf(read.fields));
    db.items.setListing(key.source, key.project, read.nodes.map((node) => node.id));
    // unlisted, not a diff of two listings: a write's re-read can store an item no listing ever named
    db.items.removeItems(key.source, db.items.unlisted(key.source, key.project));
  });
}

/** The listing as stored, rebuilt in position order, each node with what the relations query answered of it. */
export function readListing(db: ReadModel, key: ListingKey): StoredListing {
  const rows = db.githubItemRows(key.source, db.items.listing(key.source, key.project));
  return { nodes: rows.map(rebuildNode), relations: new Map(rows.map((r) => [r.item.nodeId, blockingOf(r)])) };
}

/** Whether a full read was stored for the Project (#282): every Project has fields (Title, Status…), so none stored is none read. */
export const hasListing = (db: ReadModel, key: ListingKey): boolean => db.items.fields(key.source, key.project).length > 0;

/** A Project's stored nodes for a reader with no listing of its own (#282: the settings form's filter options); undefined when there is no
 * store, no login, or nothing stored yet. */
export async function storedNodes(store: ItemStore | undefined, project: string): Promise<GhItemNode[] | undefined> {
  const source = await store?.source();
  if (store === undefined || source === undefined || !hasListing(store.db, { source, project })) return undefined;
  return readListing(store.db, { source, project }).nodes;
}
