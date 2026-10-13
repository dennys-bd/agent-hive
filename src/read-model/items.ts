import type { DatabaseSync } from 'node:sqlite';
import type { GhIssueRelations, GhItemNode } from '../sources/github-queries.js';
import type { ReadModel, SyncKind } from './db.js';
import type { ItemRow } from './rows.js';
import { inTransaction, nullable, stamp, text, upsertSql, written } from './sql.js';

// A Project's items (#190): each item's GraphQL node as JSON under the replace rule on the item's own updatedAt, its relations beside it
// outside that rule, and each full read's order. listed() runs over the stored nodes as it ran over the wire's
const ITEM_COLUMNS: readonly string[] = ['source', 'node_id', 'project', 'updated_at', 'node'];
const LISTING = `SELECT i.node, i.relations FROM project_listings l JOIN project_items i ON i.source = l.source AND i.node_id = l.node_id
  WHERE l.source = ? AND l.scope = ? ORDER BY l.position`;
// A row no listing of any scope names has left the Project: another source's listing over the same Project keeps its rows
const DROP_UNLISTED = `DELETE FROM project_items WHERE source = ? AND project = ?
  AND node_id NOT IN (SELECT node_id FROM project_listings WHERE source = ?)`;

/** What the adapter needs of the model (#190): the rows' source, and the database. */
export interface ItemStore { db: ReadModel; source(): Promise<string | undefined>; notify(repository: string, kinds: SyncKind[]): void }
/** One listing (#190): the reading account, the Project (`<owner login>/<number>`) and its scope (the Project plus its filter text). */
export interface ListingKey { source: string; project: string; scope: string }
/** A listing as stored: the nodes in order, each with its relations (undefined: none stored; null: the issue was read and is gone). */
export interface StoredListing { nodes: GhItemNode[]; relations: Map<string, GhIssueRelations | null | undefined> }

export function itemTablesOf(db: DatabaseSync, now: () => number): Pick<ReadModel, 'upsertItem' | 'setItemRelations' | 'setListing' | 'removeUnlisted' | 'listing'> {
  const upsert = db.prepare(upsertSql('project_items', ITEM_COLUMNS));
  const relate = db.prepare('UPDATE project_items SET relations = ? WHERE source = ? AND node_id = ?');
  const dropListing = db.prepare('DELETE FROM project_listings WHERE source = ? AND scope = ?');
  const addListed = db.prepare('INSERT INTO project_listings (source, scope, position, node_id) VALUES (?, ?, ?, ?)');
  const dropUnlisted = db.prepare(DROP_UNLISTED);
  const listing = db.prepare(LISTING);
  return {
    upsertItem: (row, origin) => written(upsert.run({ ...row, ...stamp(now(), origin) })),
    // JSON's null is an issue read and gone; SQL's NULL, relations never stored
    setItemRelations: (source, nodeId, relations) => { relate.run(JSON.stringify(relations), source, nodeId); },
    setListing: (source, scope, nodeIds) => inTransaction(db, () => {
      dropListing.run(source, scope);
      for (const [position, nodeId] of nodeIds.entries()) addListed.run(source, scope, position, nodeId);
    }),
    removeUnlisted: (source, project) => { dropUnlisted.run(source, project, source); },
    listing: (source, scope) => listing.all(source, scope).map((row) => ({ node: text(row, 'node'), relations: nullable(row, 'relations') })),
  };
}

// Drops the project (and its fields) and cuts the repository to its name: the repository's choices no poll step reads. The content keeps
// whatever its query asked, so a write's re-read (ITEM_FIELDS) stores more content keys than a poll's node; no poll step reads them
function pruned(node: GhItemNode): GhItemNode {
  const { id, updatedAt, fieldValueByName, fieldValues, content } = node;
  const repository = content?.repository;
  const kept = content && repository ? { ...content, repository: { nameWithOwner: repository.nameWithOwner } } : content;
  return { id, updatedAt, fieldValueByName, fieldValues, content: kept };
}

/** The normalizer: takes a poll node or a write's re-read node (GhItemFieldsNode extends GhItemNode), drops the project and the repository's choices. */
export function itemRow(source: string, project: string, node: GhItemNode): ItemRow {
  // both queries ask updatedAt; a node without it ties with every other, and the write window still decides
  return { source, nodeId: node.id, project, updatedAt: node.updatedAt ?? '', node: JSON.stringify(pruned(node)) };
}

/** One full read stored: the rows upserted, the relations set, the listing replaced, unreferenced rows of the project removed; one transaction. */
export function storeListing(db: ReadModel, key: ListingKey, nodes: GhItemNode[], relations: ReadonlyMap<string, GhIssueRelations | null>): void {
  db.transaction(() => {
    for (const node of nodes) db.upsertItem(itemRow(key.source, key.project, node), 'sync');
    for (const [nodeId, issue] of relations) db.setItemRelations(key.source, nodeId, issue);
    db.setListing(key.source, key.scope, nodes.map((node) => node.id));
    db.removeUnlisted(key.source, key.project);
  });
}

/** The listing as stored, in position order, each node with its stored relations (undefined when none was stored). The JSON is the module's own. */
export function readListing(db: ReadModel, key: ListingKey): StoredListing {
  const rows = db.listing(key.source, key.scope);
  const nodes = rows.map((row) => JSON.parse(row.node) as GhItemNode);
  const relations = rows.map((row, i): [string, GhIssueRelations | null | undefined] =>
    [nodes[i].id, row.relations === null ? undefined : (JSON.parse(row.relations) as GhIssueRelations | null)]);
  return { nodes, relations: new Map(relations) };
}
