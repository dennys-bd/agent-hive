import type { DatabaseSync } from 'node:sqlite';
import type { UpsertOrigin } from './rows.js';
import { groupBy, inTransaction, nullable, type Row, stamp, text, upsertSql, written } from './sql.js';

// The items of any tracker (#813), in neutral rows: the common columns are here, each tracker's own content is the `data` JSON. Nothing in
// this file names a tracker, so a new source adds no table. `ReadModel` exposes it as `items` (#833).

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface SourceItem {
  source: string; nodeId: string; scope: string; key: string; updatedAt: string; valuesSig: string;
  parentId: string | null; parentKey: string | null; parentTitle: string | null;
  /** The issues.node_id (same source) a GitHub item shows, through which its pull requests are reached; null elsewhere. */
  contentId: string | null;
  data: { [key: string]: JsonValue };
}
export interface SourceItemValue { field: string; kind: 'text' | 'number' | 'date' | 'option' | 'iteration'; value: string }
export interface SourceRelation { kind: 'blockedBy' | 'blocking' | 'subItem'; targetId: string | null; targetKey: string | null; title: string | null; state: string }
export interface SourceField { name: string; kind: string | null; options: string[] | null }
/** relationsRead (#833): #190's three states, outside the replace rule. null never read, false the item's content is gone, true read. */
export interface StoredSourceItem { item: SourceItem; values: SourceItemValue[]; relations: SourceRelation[]; relationsRead: boolean | null }

const COLUMNS: readonly string[] = ['source', 'node_id', 'scope', 'key', 'updated_at', 'values_sig', 'parent_id', 'parent_key', 'parent_title', 'content_id', 'data'];
const IN_IDS = 'IN (SELECT value FROM json_each(?))';
const ITEMS_KIND = 'items';
const VALUE_KINDS: readonly SourceItemValue['kind'][] = ['text', 'number', 'date', 'option', 'iteration'];
const RELATION_KINDS: readonly SourceRelation['kind'][] = ['blockedBy', 'blocking', 'subItem'];
// Same columns as db.ts's UPSERT_SCOPE, with no etag: the cursor is the only thing an items scope keeps
const UPSERT_CURSOR = `INSERT INTO sync_scopes (source, repository, kind, cursor, etag, synced_at) VALUES (?, ?, '${ITEMS_KIND}', ?, NULL, ?)
  ON CONFLICT (source, repository, kind) DO UPDATE SET cursor = excluded.cursor, etag = NULL, synced_at = excluded.synced_at`;
// The tables keyed by (source, node_id) that go with an item; the listing is keyed by position, so it is cleared apart
const OWN_TABLES: readonly string[] = ['source_items', 'source_item_values', 'source_relations'];

const itemOf = (row: Row): SourceItem => ({
  source: text(row, 'source'), nodeId: text(row, 'node_id'), scope: text(row, 'scope'), key: text(row, 'key'), updatedAt: text(row, 'updated_at'),
  valuesSig: text(row, 'values_sig'), parentId: nullable(row, 'parent_id'), parentKey: nullable(row, 'parent_key'), parentTitle: nullable(row, 'parent_title'),
  contentId: nullable(row, 'content_id'), data: JSON.parse(text(row, 'data')) as SourceItem['data'], // the module's own JSON
});
const itemValueOf = (row: Row): SourceItemValue => ({ field: text(row, 'field'), kind: VALUE_KINDS.find((k) => k === row.kind) ?? 'text', value: text(row, 'value') });
const relationOf = (row: Row): SourceRelation => ({
  kind: RELATION_KINDS.find((k) => k === row.kind) ?? 'blocking', targetId: nullable(row, 'target_id'), targetKey: nullable(row, 'target_key'),
  title: nullable(row, 'title'), state: text(row, 'state'),
});

// Each entry's position within its group (a field, a relation kind), so a multi-valued field keeps its order
function positioned<T>(entries: readonly T[], group: (entry: T) => string): [number, T][] {
  const seen = new Map<string, number>();
  return entries.map((entry): [number, T] => {
    const position = seen.get(group(entry)) ?? 0;
    seen.set(group(entry), position + 1);
    return [position, entry];
  });
}

function writersOf(db: DatabaseSync, now: () => number) {
  const upsert = db.prepare(upsertSql('source_items', COLUMNS));
  const dropValues = db.prepare('DELETE FROM source_item_values WHERE source = ? AND node_id = ?');
  const addValue = db.prepare('INSERT INTO source_item_values (source, node_id, field, position, kind, value) VALUES (?, ?, ?, ?, ?, ?)');
  const dropRelations = db.prepare(`DELETE FROM source_relations WHERE source = ? AND node_id = ? AND kind ${IN_IDS}`);
  const markRead = db.prepare('UPDATE source_items SET relations_read = ? WHERE source = ? AND node_id = ?');
  const addRelation = db.prepare('INSERT INTO source_relations (source, node_id, kind, position, target_id, target_key, title, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const dropFields = db.prepare('DELETE FROM source_fields WHERE source = ? AND scope = ?');
  const addField = db.prepare('INSERT INTO source_fields (source, scope, position, name, kind, options) VALUES (?, ?, ?, ?, ?, ?)');
  const dropListing = db.prepare('DELETE FROM source_listings WHERE source = ? AND scope = ?');
  const addListed = db.prepare('INSERT INTO source_listings (source, scope, position, node_id) VALUES (?, ?, ?, ?)');
  const upsertCursor = db.prepare(UPSERT_CURSOR);
  return {
    upsertItem: (item: SourceItem, origin: UpsertOrigin): boolean => written(upsert.run({ ...item, data: JSON.stringify(item.data), ...stamp(now(), origin) })),
    setValues: (source: string, nodeId: string, values: readonly SourceItemValue[]): void => inTransaction(db, () => {
      dropValues.run(source, nodeId);
      for (const [position, v] of positioned(values, (e) => e.field)) addValue.run(source, nodeId, v.field, position, v.kind, v.value);
    }),
    // Only the given kinds' rows are replaced (absent: every kind), since two readers each write their own kinds
    setRelations: (source: string, nodeId: string, relations: readonly SourceRelation[], kinds?: readonly SourceRelation['kind'][]): void => inTransaction(db, () => {
      dropRelations.run(source, nodeId, JSON.stringify(kinds ?? RELATION_KINDS));
      for (const [position, r] of positioned(relations, (e) => e.kind)) addRelation.run(source, nodeId, r.kind, position, r.targetId, r.targetKey, r.title, r.state);
    }),
    // Not in COLUMNS, so an upsert of the item never resets it
    setRelationsRead: (source: string, nodeId: string, read: boolean | null): void => { markRead.run(read === null ? null : Number(read), source, nodeId); },
    setFields: (source: string, scope: string, fields: readonly SourceField[]): void => inTransaction(db, () => {
      dropFields.run(source, scope);
      for (const [position, f] of fields.entries()) addField.run(source, scope, position, f.name, f.kind, f.options === null ? null : JSON.stringify(f.options));
    }),
    setListing: (source: string, scope: string, nodeIds: readonly string[]): void => inTransaction(db, () => {
      dropListing.run(source, scope);
      for (const [position, nodeId] of nodeIds.entries()) addListed.run(source, scope, position, nodeId);
    }),
    setCursor: (source: string, scope: string, cursor: string): void => { upsertCursor.run(source, scope, cursor, new Date(now()).toISOString()); },
  };
}

const readOf = (row: Row): boolean | null => (row.relations_read === null ? null : Number(row.relations_read) === 1);

function readersOf(db: DatabaseSync) {
  const listed = db.prepare('SELECT node_id FROM source_listings WHERE source = ? AND scope = ? ORDER BY position');
  const fieldRows = db.prepare('SELECT * FROM source_fields WHERE source = ? AND scope = ? ORDER BY position');
  const itemRows = db.prepare(`SELECT * FROM source_items WHERE source = ? AND node_id ${IN_IDS}`);
  const valueRows = db.prepare(`SELECT * FROM source_item_values WHERE source = ? AND node_id ${IN_IDS} ORDER BY field, position`);
  const relationRows = db.prepare(`SELECT * FROM source_relations WHERE source = ? AND node_id ${IN_IDS} ORDER BY kind, position`);
  const unlistedRows = db.prepare(`SELECT node_id FROM source_items WHERE source = $source AND scope = $scope
    AND node_id NOT IN (SELECT node_id FROM source_listings WHERE source = $source AND scope = $scope)`);
  const cursorRow = db.prepare(`SELECT cursor FROM sync_scopes WHERE source = ? AND repository = ? AND kind = '${ITEMS_KIND}'`);
  return {
    // A fixed number of queries for any number of ids: a listing is rebuilt on every poll
    items: (source: string, nodeIds: readonly string[]): StoredSourceItem[] => {
      const ids = JSON.stringify(nodeIds);
      const byId = new Map(itemRows.all(source, ids).map((row): [string, Row] => [text(row, 'node_id'), row]));
      const valuesBy = groupBy(valueRows.all(source, ids), 'node_id', itemValueOf);
      const relationsBy = groupBy(relationRows.all(source, ids), 'node_id', relationOf);
      return nodeIds.flatMap((nodeId): StoredSourceItem[] => {
        const row = byId.get(nodeId);
        return row === undefined ? [] : [{ item: itemOf(row), values: valuesBy.get(nodeId) ?? [], relations: relationsBy.get(nodeId) ?? [], relationsRead: readOf(row) }];
      });
    },
    listing: (source: string, scope: string): string[] => listed.all(source, scope).map((row) => text(row, 'node_id')),
    unlisted: (source: string, scope: string): string[] => unlistedRows.all({ source, scope }).map((row) => text(row, 'node_id')),
    fields: (source: string, scope: string): SourceField[] => fieldRows.all(source, scope).map((row) => ({
      name: text(row, 'name'), kind: nullable(row, 'kind'), options: row.options === null ? null : (JSON.parse(text(row, 'options')) as string[]),
    })),
    cursor: (source: string, scope: string): string | null => {
      const row = cursorRow.get(source, scope);
      return row === undefined ? null : nullable(row, 'cursor');
    },
  };
}

/** The store of #813: the writers, the readers and the removal of the ids a reconcile no longer finds. */
export type SourceItems = ReturnType<typeof writersOf> & ReturnType<typeof readersOf> & { removeItems(source: string, nodeIds: readonly string[]): void };

export function sourceItemsOf(db: DatabaseSync, now: () => number): SourceItems {
  const unlist = db.prepare(`DELETE FROM source_listings WHERE source = ? AND node_id ${IN_IDS}`);
  const removals = OWN_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE source = ? AND node_id ${IN_IDS}`));
  return {
    ...writersOf(db, now), ...readersOf(db),
    // Gaps left in a listing's positions keep its order, since reads sort by position
    removeItems: (source, nodeIds) => inTransaction(db, () => {
      const ids = JSON.stringify(nodeIds);
      unlist.run(source, ids);
      for (const removal of removals) removal.run(source, ids);
    }),
  };
}
