import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config.js';
import { openReadModel } from '../../src/read-model/db.js';
import type { ItemStore } from '../../src/read-model/items.js';
import { createSource, sourceSpec } from '../../src/source.js';
import { ITEM_FIELDS, ITEMS, PROBE, PROJECT_FIELDS, type GhItemFieldsNode, type GhItemNode } from '../../src/sources/github-queries.js';
import type { Gql } from '../../src/types.js';
import { combConfig, fakeGql, FILTER } from '../fakes.js';
import { SOURCE as ROWS, T1, T2 } from '../read-model/fixtures.js';

// The GitHub adapter with a read model (#190): what each poll sends, and what a write stores
const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'].map((name) => ({ id: `O_${name}`, name }));
const FIELDS = { repositoryOwner: { projectV2: { id: 'PVT_1', field: { id: 'F_status', options: OPTIONS } } } };
const RATE = { limit: 5000, remaining: 4320, resetAt: '2026-10-13T13:00:00Z' };
const probeAt = (updatedAt: string): unknown => ({ rateLimit: { ...RATE, remaining: 4999 }, repositoryOwner: { projectV2: { updatedAt } } });
const page = (nodes: GhItemNode[]): unknown => ({ rateLimit: RATE, repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes } } } });
const node = (n: number, status: string, updatedAt = T1): GhItemNode => ({
  id: `PVTI_${n}`, updatedAt, fieldValueByName: { name: status },
  content: { __typename: 'Issue', id: `I_${n}`, number: n, title: `T${n}`, body: '', url: `https://github.com/acme/r/issues/${n}`, repository: { nameWithOwner: 'acme/r' } },
});
const config = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter: FILTER } }));
const SPEC = sourceSpec(config, config.comb.sources[0]);
const names = (calls: { name: string }[]): string[] => calls.map((c) => c.name);

async function memoryStore(): Promise<ItemStore> {
  const { db } = await openReadModel(':memory:');
  return { db, source: async () => ROWS, notify: () => undefined };
}

test('with a store, a poll whose probe did not move sends only the probe and lists the stored items (#190)', async () => {
  const { gql, calls } = fakeGql({ probe: probeAt(T1), items: page([node(1, 'Ready')]), relations: {} });
  const source = createSource(SPEC, { gql, items: await memoryStore() });
  const first = await source.listItems();
  assert.deepEqual(names(calls), ['probe', 'items', 'relations']);
  calls.length = 0;
  assert.deepEqual(await source.listItems(), first);
  assert.deepEqual(names(calls), ['probe']);
});

test('with a store, a moved probe reads in full and the relations query runs (#190)', async () => {
  const { gql, calls } = fakeGql({ probe: [probeAt(T1), probeAt(T2)], items: page([node(1, 'Ready')]), relations: {} });
  const source = createSource(SPEC, { gql, items: await memoryStore() });
  await source.listItems();
  calls.length = 0;
  await source.listItems();
  assert.deepEqual(names(calls), ['probe', 'items', 'relations']);
});

test('a write clears the probe\'s stamp: the next poll reads in full (#190)', async () => {
  const { gql, calls } = fakeGql({ fields: FIELDS, setOption: {}, probe: probeAt(T1), items: page([node(1, 'Ready')]), relations: {} });
  const source = createSource(SPEC, { gql, items: await memoryStore() });
  await source.resolveFields();
  await source.listItems();
  await source.setColumn('PVTI_1', 'In progress');
  calls.length = 0;
  await source.listItems();
  assert.deepEqual(names(calls), ['probe', 'items', 'relations']);
});

test('without a store, or a store with no login, every poll reads the wire as before: no probe (#190)', async () => {
  for (const items of [undefined, { ...(await memoryStore()), source: async () => undefined }]) {
    const { gql, calls } = fakeGql({ items: page([node(1, 'Ready')]), relations: {} });
    const source = createSource(SPEC, { gql, ...(items === undefined ? {} : { items }) });
    await source.listItems();
    await source.listItems();
    assert.deepEqual(names(calls), ['items', 'relations', 'items', 'relations']);
  }
});

test('a probe-only poll takes its quota reading from the probe (#190)', async () => {
  const { gql } = fakeGql({ probe: probeAt(T1), items: page([node(1, 'Ready')]), relations: {} });
  const source = createSource(SPEC, { gql, items: await memoryStore() });
  await source.listItems();
  assert.equal((await source.quota?.())?.remaining, 4320, 'a full read: the items page, read after the probe');
  await source.listItems();
  assert.equal((await source.quota?.())?.remaining, 4999);
});

const STATUS_FIELD = { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: OPTIONS };
const reread = (status: string, updatedAt: string): GhItemFieldsNode => ({ ...node(1, status, updatedAt), project: { id: 'PVT_1', fields: { nodes: [STATUS_FIELD] } } });
// The item's reads in order and a poll page; the mutation and the relations query answer {}
function writeGql(reads: GhItemFieldsNode[], poll: GhItemNode[]): Gql {
  const queue = [...reads];
  return async (query) => {
    if (query === PROJECT_FIELDS) return FIELDS;
    if (query === PROBE) return probeAt(T1);
    if (query === ITEMS) return page(poll);
    if (query === ITEM_FIELDS) return { node: queue.shift() };
    return {};
  };
}

test('with a store, a field write stores its re-read item, and a poll read before it does not move the task back (#190)', async () => {
  const before = node(1, 'Ready', T2); // read before the write, in the write's own second
  const source = createSource(SPEC, { gql: writeGql([reread('Ready', T1), reread('In review', T2)], [before]), items: await memoryStore() });
  await source.resolveFields();
  await source.setField?.('PVTI_1', 'Status', 'In review');
  assert.deepEqual((await source.listItems()).map((task) => [task.item.itemId, task.column]), [['PVTI_1', 'In review']]);
});
