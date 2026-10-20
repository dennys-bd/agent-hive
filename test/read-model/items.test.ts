import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel, type ReadModel } from '../../src/read-model/db.js';
import { itemRow, readListing, storeListing, type ListingKey } from '../../src/read-model/items.js';
import type { GhIssueRelations, GhItemFieldsNode, GhItemNode } from '../../src/sources/github-queries.js';
import { SOURCE, T1, T2, T3 } from './fixtures.js';

// #190: a Project's items in the read model. The contract: listed() over the stored nodes answers what it answers over the wire's
const WINDOW_MS = 30_000; // #178's written_at window
const PROJECT = 'acme/6';
const KEY: ListingKey = { source: SOURCE, project: PROJECT, scope: `${PROJECT} label:"hive"` };
type Content = NonNullable<GhItemNode['content']>;

// An issue item as ITEMS reads it: in acme/r, labelled hive, no sub-issue, Status `status`
const issue = (n: number, status: string, content: Partial<Content> = {}, extra: Partial<GhItemNode> = {}): GhItemNode => ({
  id: `PVTI_${n}`, updatedAt: T1, fieldValueByName: { name: status },
  fieldValues: { nodes: [{ name: status, field: { name: 'Status' } }] },
  content: {
    __typename: 'Issue', id: `I_${n}`, number: n, title: `T${n}`, body: `body ${n}`, url: `https://github.com/acme/r/issues/${n}`, createdAt: T1,
    subIssuesSummary: { total: 0 }, subIssues: { nodes: [] }, assignees: { nodes: [] }, labels: { nodes: [{ name: 'hive' }] }, milestone: null,
    repository: { nameWithOwner: 'acme/r' }, ...content,
  },
  ...extra,
});
// Every kind of set value an item can carry: ITEMS asks the first two kinds, a write's re-read all five
const EVERY_VALUE = { nodes: [
  { name: 'Ready', field: { name: 'Status' } }, { name: 'P1', field: { name: 'Priority' } }, { text: 'api', field: { name: 'Area' } },
  { number: 3, field: { name: 'Estimate' } }, { date: '2026-10-20', field: { name: 'Due' } }, { title: 'Sprint 1', field: { name: 'Sprint' } },
] };
// A write's re-read (ITEM_FIELDS) carries the project's fields and the repository's choices beyond the poll's shape
const REREAD: GhItemFieldsNode = {
  ...issue(8, 'In review', { repository: { nameWithOwner: 'acme/r', assignableUsers: { nodes: [{ id: 'U_bia', login: 'bia' }] }, labels: { nodes: [{ id: 'L_hive', name: 'hive' }] } } }),
  project: { id: 'PVT_1', fields: { nodes: [{ id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT' }] } },
};
const WIRE: GhItemNode[] = [
  issue(1, 'Ready', { subIssuesSummary: { total: 2 }, subIssues: { nodes: [{ id: 'I_2', state: 'OPEN' }, { id: 'I_3', state: 'CLOSED' }] } }), // an epic
  issue(2, 'Ready', { assignees: { nodes: [{ login: 'bia' }] }, milestone: { title: 'v1' } }, { fieldValues: EVERY_VALUE }),
  issue(3, 'Done'), // a closed sub-issue, in a column no stage cites
  issue(4, 'In progress', { labels: { nodes: [{ name: 'docs' }] } }), // the filter drops it
  issue(5, 'In progress'), // blocked by #2
  { id: 'PVTI_6', updatedAt: T1, fieldValueByName: { name: 'Ready' }, content: { __typename: 'DraftIssue', title: 'Draft' } },
  { id: 'PVTI_7', updatedAt: T1, fieldValueByName: null, content: null },
  REREAD,
];
const ref = (number: number, state: string) => ({ number, title: `T${number}`, state, repository: { nameWithOwner: 'acme/r' } });
const BLOCKED: GhIssueRelations = { blockedBy: { nodes: [ref(2, 'OPEN')] }, blocking: { nodes: [] }, subIssues: { nodes: [] } };
// The kept tasks are #1, #2, #5 and #8, aliased i0 to i3; i3's repository is gone by the time the relations are asked
// The adapter's poll over these nodes as the wire answers them: every poll step, relations included
const memoryModel = async (now: () => number = () => 1_000): Promise<ReadModel> => (await openReadModel(':memory:', { now })).db;
const at = (status: string, updatedAt: string, n = 1): GhItemNode => ({ ...issue(n, status), updatedAt });
const ids = (db: ReadModel, key: ListingKey): string[] => readListing(db, key).nodes.map((node) => node.id);


test('the relations come back by item id: a stored null stays null, an item with none stored reads undefined (#190)', async () => {
  const db = await memoryModel();
  storeListing(db, KEY, WIRE, new Map([['PVTI_5', BLOCKED], ['PVTI_8', null]]));
  const { relations } = readListing(db, KEY);
  assert.deepEqual([relations.get('PVTI_5'), relations.get('PVTI_8'), relations.get('PVTI_1')], [BLOCKED, null, undefined]);
});

test('the replace rule on the item\'s updatedAt (#190): an unchanged item writes nothing, an older one is refused, a tie inside the window keeps a written row', async () => {
  const clock = { now: 1_000 };
  const db = await memoryModel(() => clock.now);
  assert.equal(db.upsertItem(itemRow(SOURCE, PROJECT, at('Ready', T2)), 'sync'), true);
  assert.equal(db.upsertItem(itemRow(SOURCE, PROJECT, at('Ready', T2)), 'sync'), false, 'unchanged');
  assert.equal(db.upsertItem(itemRow(SOURCE, PROJECT, at('Done', T1)), 'sync'), false, 'older');
  assert.equal(db.upsertItem(itemRow(SOURCE, PROJECT, at('In review', T3)), 'write'), true);
  clock.now += WINDOW_MS - 1;
  assert.equal(db.upsertItem(itemRow(SOURCE, PROJECT, at('Ready', T3)), 'sync'), false, 'a tie inside the window');
  clock.now += 1;
  assert.equal(db.upsertItem(itemRow(SOURCE, PROJECT, at('Ready', T3)), 'sync'), true, 'past it the poll is the truth again');
});

test('a full read drops an item no longer listed, its row with its place (#190)', async () => {
  const db = await memoryModel();
  storeListing(db, KEY, [at('Ready', T1, 1), at('Ready', T1, 2)], new Map());
  storeListing(db, KEY, [at('Ready', T1, 2)], new Map());
  assert.deepEqual(ids(db, KEY), ['PVTI_2']);
  assert.equal(db.upsertItem(itemRow(SOURCE, PROJECT, at('Ready', T1, 1)), 'sync'), true, 'no row was left to compare with');
});

test('two scopes over one Project keep their own order and membership; a full read of one keeps the rows only the other lists (#190)', async () => {
  const db = await memoryModel();
  const other: ListingKey = { ...KEY, scope: PROJECT };
  storeListing(db, KEY, [at('Ready', T1, 1), at('Ready', T1, 2)], new Map());
  storeListing(db, other, [at('Ready', T1, 3), at('Ready', T1, 1)], new Map());
  storeListing(db, KEY, [at('Ready', T1, 2)], new Map());
  assert.deepEqual([ids(db, KEY), ids(db, other)], [['PVTI_2'], ['PVTI_3', 'PVTI_1']]);
});

test('itemRow drops the project and cuts the repository to its name: a write\'s re-read is stored in the poll\'s shape (#190)', () => {
  const row = itemRow(SOURCE, PROJECT, REREAD);
  const stored = JSON.parse(row.node) as GhItemFieldsNode;
  assert.deepEqual([row.source, row.nodeId, row.project, row.updatedAt], [SOURCE, 'PVTI_8', PROJECT, T1]);
  assert.equal(stored.project, undefined);
  assert.deepEqual(stored.content?.repository, { nameWithOwner: 'acme/r' });
});

