import type { DatabaseSync } from 'node:sqlite';
import type { ReadModel } from './db.js';
import type { FieldValueRow, IssueDetails, RelationKind, RelationRow, StoredItem, StoredItemRows } from './rows.js';
import { groupBy, inTransaction, issueOf, nullable, prOf, type Row, stamp, text, upsertSql, WRITE_WINDOW_MS, written } from './sql.js';

// A Project's items (#190), normalized (#282): the item's own columns under the replace rule on its updated_at; its set values, its issue's
// relations and details and the Project's fields beside them, each replaced whole by its one writer; each full read's order per Project
type ItemTables = Pick<ReadModel, 'upsertItem' | 'setItemValues' | 'setIssueRelations' | 'setBlocking' | 'setIssueDetails' | 'setProjectFields'
  | 'projectFields' | 'setListing' | 'removeUnlisted' | 'listing' | 'itemRows'>;

const ITEM_COLUMNS: readonly string[] = ['source', 'node_id', 'project', 'content_type', 'issue_node_id', 'values_sig', 'updated_at'];
const IN_IDS = 'IN (SELECT value FROM json_each(?))';
// The issue's own columns only the Project read says (#282), under the replace rule's terms: at this read's updated_at, and never a write's inside
// its window. A REST row stored first at the same updated_at takes them, which "only when the issue row wrote" would leave stale for good
const DETAILS = `UPDATE issues SET url = $url, milestone = $milestone, issue_type = $issueType, parent_number = $parentNumber, parent_title = $parentTitle,
  sub_issues_total = $subIssuesTotal, sub_issues_completed = $subIssuesCompleted,
  written_at = CASE WHEN $writtenAt IS NOT NULL THEN $writtenAt ELSE written_at END
  WHERE source = $source AND node_id = $nodeId AND updated_at = $updatedAt
    AND ($writtenAt IS NOT NULL OR written_at IS NULL OR $now - written_at >= ${WRITE_WINDOW_MS})`;
// The items of a Project its listing no longer names: they left it
const UNLISTED = `SELECT node_id FROM project_items WHERE source = $source AND project = $project
  AND node_id NOT IN (SELECT node_id FROM project_listings WHERE source = $source AND project = $project)`;
const REMOVALS = [ // values and relations first: the relations are found through the rows the last statement deletes
  `DELETE FROM item_field_values WHERE source = $source AND item_node_id IN (${UNLISTED})`,
  // an issue another Project (or this one's kept items) still lists keeps its relations: they are the issue's, not the Project's
  `DELETE FROM issue_relations WHERE source = $source AND issue_node_id IN (SELECT issue_node_id FROM project_items WHERE source = $source AND node_id IN (${UNLISTED}))
    AND issue_node_id NOT IN (SELECT issue_node_id FROM project_items WHERE source = $source AND issue_node_id IS NOT NULL
      AND node_id NOT IN (${UNLISTED}))`,
  `DELETE FROM project_items WHERE source = $source AND node_id IN (${UNLISTED})`,
];
const VALUE_KINDS: readonly FieldValueRow['kind'][] = ['name', 'text', 'number', 'date', 'title'];
const RELATION_KINDS: readonly RelationKind[] = ['blockedBy', 'blocking', 'subIssue'];
const count = (row: Row, key: string): number | null => (row[key] === null ? null : Number(row[key]));

function relationsOf(db: DatabaseSync): Pick<ReadModel, 'setIssueRelations' | 'setBlocking'> {
  const drop = db.prepare(`DELETE FROM issue_relations WHERE source = ? AND issue_node_id = ? AND kind ${IN_IDS}`);
  const add = db.prepare('INSERT INTO issue_relations (source, issue_node_id, kind, position, node_id, number, title, state, repository) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const issueOfItem = db.prepare('SELECT issue_node_id FROM project_items WHERE source = ? AND node_id = ?');
  const mark = db.prepare('UPDATE project_items SET blocking_read = ? WHERE source = ? AND node_id = ?');
  const setIssueRelations: ReadModel['setIssueRelations'] = (source, issueNodeId, kinds, rows) => inTransaction(db, () => {
    drop.run(source, issueNodeId, JSON.stringify(kinds));
    for (const [position, r] of rows.entries()) add.run(source, issueNodeId, r.kind, position, r.nodeId, r.number, r.title, r.state, r.repository);
  });
  return {
    setIssueRelations,
    // The marker on the item, the rows under its issue: an item whose issue is gone may have none to hold them
    setBlocking: (source, itemNodeId, rows) => inTransaction(db, () => {
      mark.run(rows === null ? 0 : 1, source, itemNodeId);
      const found = issueOfItem.get(source, itemNodeId);
      const issueNodeId = found === undefined ? null : nullable(found, 'issue_node_id');
      if (issueNodeId !== null) setIssueRelations(source, issueNodeId, ['blocking'], rows ?? []);
    }),
  };
}

function writesOf(db: DatabaseSync, now: () => number): Pick<ReadModel, 'upsertItem' | 'setItemValues' | 'setIssueDetails' | 'setProjectFields' | 'setListing' | 'removeUnlisted'> {
  const upsert = db.prepare(upsertSql('project_items', ITEM_COLUMNS));
  const dropValues = db.prepare('DELETE FROM item_field_values WHERE source = ? AND item_node_id = ?');
  const addValue = db.prepare('INSERT INTO item_field_values (source, item_node_id, field, kind, value) VALUES (?, ?, ?, ?, ?)');
  const details = db.prepare(DETAILS);
  const dropFields = db.prepare('DELETE FROM project_fields WHERE source = ? AND project = ?');
  const addField = db.prepare('INSERT INTO project_fields (source, project, position, name, data_type, options) VALUES (?, ?, ?, ?, ?, ?)');
  const dropListing = db.prepare('DELETE FROM project_listings WHERE source = ? AND project = ?');
  const addListed = db.prepare('INSERT INTO project_listings (source, project, position, node_id) VALUES (?, ?, ?, ?)');
  const removals = REMOVALS.map((sql) => db.prepare(sql));
  return {
    upsertItem: (row, origin) => written(upsert.run({ ...row, ...stamp(now(), origin) })),
    setItemValues: (source, itemNodeId, values) => inTransaction(db, () => {
      dropValues.run(source, itemNodeId);
      for (const v of values) addValue.run(source, itemNodeId, v.field, v.kind, v.value);
    }),
    setIssueDetails: (source, nodeId, updatedAt, value, origin) => written(details.run({ source, nodeId, updatedAt, ...value, ...stamp(now(), origin) })),
    setProjectFields: (source, project, fields) => inTransaction(db, () => {
      dropFields.run(source, project);
      for (const [position, f] of fields.entries()) addField.run(source, project, position, f.name, f.dataType, f.options === null ? null : JSON.stringify(f.options));
    }),
    setListing: (source, project, nodeIds) => inTransaction(db, () => {
      dropListing.run(source, project);
      for (const [position, nodeId] of nodeIds.entries()) addListed.run(source, project, position, nodeId);
    }),
    removeUnlisted: (source, project) => inTransaction(db, () => {
      for (const removal of removals) removal.run({ source, project });
    }),
  };
}

const storedItemOf = (row: Row): StoredItem => ({
  source: text(row, 'source'), nodeId: text(row, 'node_id'), project: text(row, 'project'), contentType: nullable(row, 'content_type'),
  issueNodeId: nullable(row, 'issue_node_id'), updatedAt: text(row, 'updated_at'), valuesSig: text(row, 'values_sig'), blockingRead: count(row, 'blocking_read'),
});
const valueRowOf = (row: Row): FieldValueRow => ({ field: text(row, 'field'), kind: VALUE_KINDS.find((k) => k === row.kind) ?? 'text', value: text(row, 'value') });
const relationOf = (row: Row): RelationRow => ({
  kind: RELATION_KINDS.find((k) => k === row.kind) ?? 'blocking', nodeId: nullable(row, 'node_id'), number: count(row, 'number'),
  title: nullable(row, 'title'), state: text(row, 'state'), repository: nullable(row, 'repository'),
});
// Written only by a Project read (#282): an issue the REST sync stored and no Project read reached yet has none
const detailsOf = (row: Row): IssueDetails | undefined => (row.url === null ? undefined : {
  url: text(row, 'url'), milestone: nullable(row, 'milestone'), issueType: nullable(row, 'issue_type'), parentNumber: count(row, 'parent_number'),
  parentTitle: nullable(row, 'parent_title'), subIssuesTotal: count(row, 'sub_issues_total'), subIssuesCompleted: count(row, 'sub_issues_completed'),
});

// Five queries for any number of items, not five per item: a listing of 1000 is rebuilt on every poll
function rowsReader(db: DatabaseSync): ReadModel['itemRows'] {
  const items = db.prepare(`SELECT * FROM project_items WHERE source = ? AND node_id ${IN_IDS}`);
  const values = db.prepare(`SELECT * FROM item_field_values WHERE source = ? AND item_node_id ${IN_IDS} ORDER BY field`);
  const issues = db.prepare(`SELECT * FROM issues WHERE source = ? AND node_id ${IN_IDS}`);
  const prs = db.prepare(`SELECT * FROM issue_pull_requests WHERE source = ? AND issue_node_id ${IN_IDS} ORDER BY number`);
  const relations = db.prepare(`SELECT * FROM issue_relations WHERE source = ? AND issue_node_id ${IN_IDS} ORDER BY kind, position`);
  return (source, nodeIds) => {
    const ids = JSON.stringify(nodeIds);
    const byId = new Map(items.all(source, ids).map((row): [string, StoredItem] => [text(row, 'node_id'), storedItemOf(row)]));
    const issueIds = JSON.stringify([...byId.values()].flatMap((item) => item.issueNodeId ?? []));
    const issueRows = new Map(issues.all(source, issueIds).map((row): [string, Row] => [text(row, 'node_id'), row]));
    const valuesBy = groupBy(values.all(source, ids), 'item_node_id', valueRowOf);
    const prsBy = groupBy(prs.all(source, issueIds), 'issue_node_id', prOf);
    const relationsBy = groupBy(relations.all(source, issueIds), 'issue_node_id', relationOf);
    return nodeIds.flatMap((nodeId): StoredItemRows[] => {
      const item = byId.get(nodeId);
      if (item === undefined) return [];
      const issueId = item.issueNodeId ?? '';
      const issue = issueRows.get(issueId);
      const details = issue === undefined ? undefined : detailsOf(issue);
      return [{
        item, values: valuesBy.get(nodeId) ?? [], ...(issue === undefined ? {} : { issue: issueOf(issue) }), ...(details === undefined ? {} : { details }),
        pullRequests: prsBy.get(issueId) ?? [], relations: relationsBy.get(issueId) ?? [],
      }];
    });
  };
}

export function itemTablesOf(db: DatabaseSync, now: () => number): ItemTables {
  const listed = db.prepare('SELECT node_id FROM project_listings WHERE source = ? AND project = ? ORDER BY position');
  const fields = db.prepare('SELECT * FROM project_fields WHERE source = ? AND project = ? ORDER BY position');
  return {
    ...writesOf(db, now), ...relationsOf(db), itemRows: rowsReader(db),
    listing: (source, project) => listed.all(source, project).map((row) => text(row, 'node_id')),
    // the module's own JSON: an array of names
    projectFields: (source, project) => fields.all(source, project).map((row) => ({
      name: text(row, 'name'), dataType: nullable(row, 'data_type'), options: row.options === null ? null : (JSON.parse(text(row, 'options')) as string[]),
    })),
  };
}
