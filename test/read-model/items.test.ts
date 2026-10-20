import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import { normalizeItem, readListing, storeListing, writeItem, type ListingKey } from '../../src/read-model/items.js';
import { WireError } from '../../src/read-model/normalize.js';
import type { GhIssueRelations, GhItemNode } from '../../src/sources/github-queries.js';
import { tempDir } from '../temp-dir.js';
import { itemNode, OTHER_SOURCE, SOURCE, T1, T2, T3 } from './fixtures.js';

// #282: a Project's items in normalized tables: the item's replace rule, what follows its write decision, removal, the listing's key, SQL
const WINDOW_MS = 30_000; // #178's written_at window
const PROJECT = 'acme/6';
const KEY: ListingKey = { source: SOURCE, project: PROJECT };
const memoryModel = async (now: () => number = () => 1_000): Promise<ReadModel> => (await openReadModel(':memory:', { now })).db;
const read = (nodes: GhItemNode[]) => ({ nodes, fields: [] });
const at = (status: string, updatedAt: string, n = 1): GhItemNode => itemNode(n, status, updatedAt);
const ids = (db: ReadModel, key: ListingKey = KEY): string[] => readListing(db, key).nodes.map((node) => node.id);
const seven = { number: 7, title: 'T7', state: 'OPEN', repository: { nameWithOwner: 'acme/r' } };
const BLOCKED: GhIssueRelations = { blocking: { nodes: [{ ...seven, number: 5, title: 'T5' }] } };

test('the replace rule on the item\'s updatedAt (#190): a new item writes, an unchanged one writes nothing, an older one is refused, a newer write lands', async () => {
  const db = await memoryModel();
  const row = (updatedAt: string) => normalizeItem(SOURCE, PROJECT, at('Ready', updatedAt)).item;
  assert.equal(db.upsertItem(row(T2), 'sync'), true);
  assert.equal(db.upsertItem(row(T2), 'sync'), false, 'unchanged: no disk write');
  assert.equal(db.upsertItem(row(T1), 'sync'), false, 'older');
  assert.equal(db.upsertItem(row(T3), 'write'), true, 'newer');
});

test('the write window (#282): a poll page read before a write, landing after it inside the window, changes neither the item\'s values nor its issue details; past the window it does. Relations follow every read', async () => {
  const clock = { now: 1_000 };
  const db = await memoryModel(() => clock.now);
  const before = itemNode(1, 'Ready', T2, { milestone: { title: 'v1' } });
  const written = itemNode(1, 'In review', T2, { milestone: { title: 'v2' }, blockedBy: { nodes: [seven] } });
  storeListing(db, KEY, read([at('Ready', T1)]), new Map());
  writeItem(db, normalizeItem(SOURCE, PROJECT, written), 'write');
  clock.now += WINDOW_MS - 1;
  storeListing(db, KEY, read([before]), new Map());
  const shown = (): unknown[] => {
    const [node] = readListing(db, KEY).nodes;
    return [node.fieldValueByName?.name, node.content?.milestone?.title, node.content?.blockedBy?.nodes.map((r) => r.number)];
  };
  assert.deepEqual(shown(), ['In review', 'v2', []], 'the relations are the last read\'s: a closed blocker must not stay forever');
  clock.now += 1;
  storeListing(db, KEY, read([before]), new Map());
  assert.deepEqual(shown()[1], 'v1', 'past the window the poll is the truth again for the issue\'s details');
});

test('every kind of value comes back under its own key, a number as a number; Status is rebuilt from its row; an unreadable value is not stored (#282)', async () => {
  const db = await memoryModel();
  const values = { nodes: [
    { name: 'Ready', field: { name: 'Status' } }, { text: 'api', field: { name: 'Area' } }, { number: 3.5, field: { name: 'Estimate' } },
    { date: '2026-10-20', field: { name: 'Due' } }, { title: 'Sprint 1', field: { name: 'Sprint' } }, {},
  ] };
  storeListing(db, KEY, read([itemNode(1, 'Ready', T1, {}, { fieldValues: values })]), new Map());
  const [node] = readListing(db, KEY).nodes;
  assert.deepEqual(node.fieldValueByName, { name: 'Ready' });
  assert.deepEqual(node.fieldValues?.nodes, [
    { text: 'api', field: { name: 'Area' } }, { date: '2026-10-20', field: { name: 'Due' } }, { number: 3.5, field: { name: 'Estimate' } },
    { title: 'Sprint 1', field: { name: 'Sprint' } }, { name: 'Ready', field: { name: 'Status' } },
  ], 'by field name');
});

test('a full read drops an item no longer listed with its values and relations; its issue row stays, the repository views\' own (#282)', async () => {
  const db = await memoryModel();
  const blocked = itemNode(1, 'Ready', T1, { blockedBy: { nodes: [seven] } });
  storeListing(db, KEY, read([blocked, at('Ready', T1, 2)]), new Map([['PVTI_1', BLOCKED]]));
  storeListing(db, KEY, read([at('Ready', T1, 2)]), new Map());
  assert.deepEqual(ids(db), ['PVTI_2']);
  assert.equal(db.issue(SOURCE, 'acme/r', 1)?.title, 'T1', 'the issue stays');
  assert.equal(db.upsertItem(normalizeItem(SOURCE, PROJECT, blocked).item, 'sync'), true, 'no item row was left to compare with');
  const [rows] = db.itemRows(SOURCE, ['PVTI_1']);
  assert.deepEqual([rows?.values, rows?.relations, rows?.item.blockingRead], [[], [], null], 'its values, relations and marker went with it');
});

test('one listing per Project and reading account: the read is unfiltered, so the Hive\'s sources over one Project share it; another account keeps its own (#282)', async () => {
  const db = await memoryModel();
  const other: ListingKey = { ...KEY, source: OTHER_SOURCE };
  storeListing(db, KEY, read([at('Ready', T1, 1), at('Ready', T1, 2)]), new Map());
  storeListing(db, other, read([at('Ready', T1, 3)]), new Map());
  assert.deepEqual([ids(db), ids(db, other)], [['PVTI_1', 'PVTI_2'], ['PVTI_3']]);
});

test('a field value is found by SQL, through the index on item_field_values (source, field, value) (#282)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  const { db } = await openReadModel(path);
  t.after(() => db.close());
  storeListing(db, KEY, read([at('Ready', T1, 1), at('In review', T1, 2)]), new Map());
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  const sql = 'SELECT item_node_id FROM item_field_values WHERE source = ? AND field = ? AND value = ?';
  assert.deepEqual(raw.prepare(sql).all(SOURCE, 'Status', 'In review').map((row) => row.item_node_id), ['PVTI_2']);
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(SOURCE, 'Status', 'In review').map((row) => String(row.detail));
  assert.ok(plan.some((step) => step.includes('item_field_values_by_value')), plan.join('\n'));
});

test('the relations marker (#190, #282): read, gone (null) or never read (undefined); a full read that asked none keeps what was read', async () => {
  const db = await memoryModel();
  const nodes = [at('Ready', T1, 1), at('Ready', T1, 5), at('Ready', T1, 8)];
  storeListing(db, KEY, read(nodes), new Map([['PVTI_5', BLOCKED], ['PVTI_8', null]]));
  const { relations } = readListing(db, KEY);
  assert.deepEqual([relations.get('PVTI_5'), relations.get('PVTI_8'), relations.get('PVTI_1')], [BLOCKED, null, undefined]);
  storeListing(db, KEY, read(nodes), new Map());
  assert.deepEqual(readListing(db, KEY).relations.get('PVTI_5'), BLOCKED);
});

test('the Project\'s fields are replaced whole on each full read and read back in order, a nameless one left out (#282)', async () => {
  const db = await memoryModel();
  const fields = [
    { name: 'Status', dataType: 'SINGLE_SELECT', options: [{ name: 'Ready' }] }, {},
    { name: 'Sprint', dataType: 'ITERATION', configuration: { iterations: [{ title: 'S1' }] } }, { name: 'Notes', dataType: 'TEXT' },
  ];
  storeListing(db, KEY, { nodes: [], fields }, new Map());
  assert.deepEqual(db.projectFields(SOURCE, PROJECT), [
    { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Ready'] }, { name: 'Sprint', dataType: 'ITERATION', options: ['S1'] },
    { name: 'Notes', dataType: 'TEXT', options: null },
  ]);
  storeListing(db, KEY, { nodes: [], fields: [{ name: 'Notes', dataType: 'TEXT' }] }, new Map());
  assert.deepEqual(db.projectFields(SOURCE, PROJECT), [{ name: 'Notes', dataType: 'TEXT', options: null }]);
});

test('an item whose issue row is gone rebuilds with no content; a draft keeps its type (#282)', async () => {
  const db = await memoryModel();
  const draft: GhItemNode = { id: 'PVTI_6', updatedAt: T1, fieldValueByName: { name: 'Ready' }, content: { __typename: 'DraftIssue' } };
  storeListing(db, KEY, read([at('Ready', T1, 1), draft]), new Map());
  db.removeIssue(SOURCE, 'I_1'); // what the REST reconcile does to an issue that left its repository
  assert.deepEqual(readListing(db, KEY).nodes.map((node) => node.content), [null, { __typename: 'DraftIssue' }]);
});

test('a malformed issue throws before anything is stored (#282)', async () => {
  const db = await memoryModel();
  assert.throws(() => storeListing(db, KEY, read([at('Ready', T1, 1), itemNode(2, 'Ready', T1, { comments: null })]), new Map()), WireError);
  assert.deepEqual(ids(db), []);
});

test('a read at the same updatedAt with another field value stores it; inside the write window after a write it does not (#282)', async () => {
  const clock = { now: 1_000 };
  const db = await memoryModel(() => clock.now);
  const status = (): string | undefined => readListing(db, KEY).nodes[0]?.fieldValueByName?.name;
  storeListing(db, KEY, read([at('Ready', T2)]), new Map());
  storeListing(db, KEY, read([at('In review', T2)]), new Map());
  assert.equal(status(), 'In review', 'a tie with other values writes');
  writeItem(db, normalizeItem(SOURCE, PROJECT, at('Done', T2)), 'write');
  clock.now += WINDOW_MS - 1;
  storeListing(db, KEY, read([at('Ready', T2)]), new Map());
  assert.equal(status(), 'Done', 'the window protects the write');
});

test('a write changing only the milestone is kept against a page read before it, inside the window (#282)', async () => {
  const clock = { now: 1_000 };
  const db = await memoryModel(() => clock.now);
  storeListing(db, KEY, read([itemNode(1, 'Ready', T2, { milestone: { title: 'v1' } })]), new Map());
  writeItem(db, normalizeItem(SOURCE, PROJECT, itemNode(1, 'Ready', T2, { milestone: { title: 'v2' } })), 'write');
  clock.now += WINDOW_MS - 1;
  storeListing(db, KEY, read([itemNode(1, 'Ready', T2, { milestone: { title: 'v1' } })]), new Map());
  assert.equal(readListing(db, KEY).nodes[0]?.content?.milestone?.title, 'v2');
});

test('an issue that is an item of two Projects keeps its relations when one Project drops it (#282)', async () => {
  const db = await memoryModel();
  const other: ListingKey = { ...KEY, project: 'acme/7' };
  const blocked = itemNode(1, 'Ready', T1, { blockedBy: { nodes: [seven] } });
  storeListing(db, KEY, read([blocked]), new Map());
  storeListing(db, other, read([{ ...blocked, id: 'PVTI_9' }]), new Map());
  storeListing(db, KEY, read([]), new Map());
  const [rows] = db.itemRows(SOURCE, ['PVTI_9']);
  assert.deepEqual(rows?.relations.map((r) => r.number), [7]);
});
