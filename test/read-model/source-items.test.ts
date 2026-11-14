import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/read-model/db.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import { sourceItemsOf, type SourceItem, type SourceItemValue } from '../../src/read-model/source-items.js';
import { issueRow, SOURCE, T1, T2, T3 } from './fixtures.js';

const JIRA = 'jira:acme.example:acct-1';
const NOW = Date.parse('2026-10-05T12:00:00Z');

const item = (n: number, updatedAt = T1, extra: Partial<SourceItem> = {}): SourceItem => ({
  source: JIRA, nodeId: `N${n}`, scope: 'S1', key: `HIVE-${n}`, updatedAt, valuesSig: `sig${n}`, parentId: null, parentKey: null, parentTitle: null,
  contentId: null, data: { title: `Item ${n}`, labels: ['a', 'b'] }, ...extra,
});
const open = () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS);
  return { db, store: sourceItemsOf(db, () => NOW) };
};
const count = (db: DatabaseSync, sql: string): number => Number(db.prepare(sql).get()?.n);

test('a file one migration behind keeps its GitHub rows after the full migration', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS.slice(0, -1));
  const r = issueRow(1, T1);
  db.prepare(`INSERT INTO issues (source, node_id, repository, number, kind, state, title, body, labels, assignees, created_at, updated_at, comments)
    VALUES (?, ?, ?, ?, 'issue', 'open', ?, '', '[]', '[]', ?, ?, 0)`).run(SOURCE, r.nodeId, r.repository, r.number, r.title, T1, T1);
  db.prepare("INSERT INTO project_items (source, node_id, project, values_sig, updated_at) VALUES (?, 'PVTI_1', 'P1', 's', ?)").run(SOURCE, T1);
  migrate(db, MIGRATIONS);
  assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), MIGRATIONS.length);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM issues'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM project_items'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM source_items'), 0);
});

test('a stored listing reads back whole and in order', () => {
  const { store } = open();
  const a = item(1, T1, { parentId: 'N9', parentKey: 'HIVE-9', parentTitle: 'Epic' });
  const b = item(2);
  const fields = [{ name: 'Status', kind: 'option', options: ['Todo', 'Done'] }, { name: 'Notes', kind: 'text', options: null }];
  for (const i of [b, a]) assert.equal(store.upsertItem(i, 'sync'), true);
  store.setValues(JIRA, 'N1', [{ field: 'Status', kind: 'option', value: 'Todo' }, { field: 'Tags', kind: 'text', value: 'x' }, { field: 'Tags', kind: 'text', value: 'a' }]);
  store.setRelations(JIRA, 'N1', [{ kind: 'blockedBy', targetId: 'N2', targetKey: 'HIVE-2', title: 'Two', state: 'open' }]);
  store.setFields(JIRA, 'S1', fields);
  store.setListing(JIRA, 'S1', ['N1', 'N2']);
  assert.deepEqual(store.listing(JIRA, 'S1'), ['N1', 'N2']);
  assert.deepEqual(store.fields(JIRA, 'S1'), fields);
  const read = store.items(JIRA, ['N2', 'missing', 'N1']);
  assert.deepEqual(read.map((r) => r.item), [b, a]);
  assert.deepEqual(read[1]?.values.map((v) => v.value), ['Todo', 'x', 'a']);
  assert.deepEqual(read[1]?.relations, [{ kind: 'blockedBy', targetId: 'N2', targetKey: 'HIVE-2', title: 'Two', state: 'open' }]);
  assert.deepEqual(read[0]?.values, []);
});

test('upserting one item changes only that item and keeps the listing order', () => {
  const { store } = open();
  store.upsertItem(item(1), 'sync');
  store.upsertItem(item(2), 'sync');
  store.setListing(JIRA, 'S1', ['N2', 'N1']);
  assert.equal(store.upsertItem(item(1, T2, { data: { title: 'New' } }), 'sync'), true);
  assert.deepEqual(store.listing(JIRA, 'S1'), ['N2', 'N1']);
  assert.deepEqual(store.items(JIRA, ['N1', 'N2']).map((r) => r.item.data), [{ title: 'New' }, item(2).data]);
});

test('an older updated_at does not overwrite', () => {
  const { store } = open();
  store.upsertItem(item(1, T2), 'sync');
  assert.equal(store.upsertItem(item(1, T1, { data: { title: 'Stale' } }), 'sync'), false);
  assert.deepEqual(store.items(JIRA, ['N1'])[0]?.item.data, item(1).data);
});

test('a sync cursor is kept per account and scope', () => {
  const { store } = open();
  assert.equal(store.cursor(JIRA, 'S1'), null);
  store.setCursor(JIRA, 'S1', 'c1');
  store.setCursor(JIRA, 'S2', 'c2');
  store.setCursor(SOURCE, 'S1', 'c3');
  assert.deepEqual([store.cursor(JIRA, 'S1'), store.cursor(JIRA, 'S2'), store.cursor(SOURCE, 'S1')], ['c1', 'c2', 'c3']);
  store.setCursor(JIRA, 'S1', 'c4');
  assert.equal(store.cursor(JIRA, 'S1'), 'c4');
});

test('removing items drops their values, relations and listing positions', () => {
  const { db, store } = open();
  for (const n of [1, 2]) {
    store.upsertItem(item(n), 'sync');
    store.setValues(JIRA, `N${n}`, [{ field: 'F', kind: 'text', value: 'v' }]);
    store.setRelations(JIRA, `N${n}`, [{ kind: 'subItem', targetId: 'X', targetKey: null, title: null, state: 'open' }]);
  }
  store.setListing(JIRA, 'S1', ['N1', 'N2']);
  store.removeItems(JIRA, ['N1']);
  for (const table of ['source_items', 'source_item_values', 'source_relations', 'source_listings']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table}`), 1, table);
  }
  assert.deepEqual(store.listing(JIRA, 'S1'), ['N2']);
  assert.equal(store.items(JIRA, ['N1']).length, 0);
});

test('a GitHub-shaped item reads back whole and its content_id reaches the closing PR', () => {
  const { db, store } = open();
  const r = issueRow(7, T1);
  db.prepare(`INSERT INTO issues (source, node_id, repository, number, kind, state, title, body, labels, assignees, created_at, updated_at, comments)
    VALUES (?, ?, ?, ?, 'issue', 'open', ?, '', '[]', '[]', ?, ?, 0)`).run(SOURCE, r.nodeId, r.repository, r.number, r.title, T1, T1);
  db.prepare("INSERT INTO issue_pull_requests (source, issue_node_id, number, url, state, draft) VALUES (?, ?, 70, 'u', 'open', 0)").run(SOURCE, r.nodeId);
  const gh = item(1, T3, { source: SOURCE, nodeId: 'PVTI_1', scope: 'P1', key: 'acme/hive#7', parentId: 'I_1', parentKey: 'acme/hive#1', parentTitle: 'Parent', contentId: r.nodeId });
  store.upsertItem(gh, 'sync');
  const values: SourceItemValue[] = [{ field: 'Size', kind: 'number', value: '3' }, { field: 'Sprint', kind: 'iteration', value: 'Sprint 4' }];
  store.setValues(SOURCE, 'PVTI_1', values);
  const [read] = store.items(SOURCE, ['PVTI_1']);
  assert.deepEqual(read, { item: gh, values, relations: [] });
  const pr = db.prepare(`SELECT p.number FROM source_items s JOIN issue_pull_requests p ON p.source = s.source AND p.issue_node_id = s.content_id
    WHERE s.source = ? AND s.node_id = ?`).get(SOURCE, 'PVTI_1');
  assert.equal(Number(pr?.number), 70);
});
