import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config.js';
import { openReadModel } from '../../src/read-model/db.js';
import type { ItemStore } from '../../src/read-model/items.js';
import { createSource, resolveSources, sourceSpec } from '../../src/source.js';
import { ITEM_FIELDS, ITEMS, PROBE, PROJECT_FIELDS, type GhItemFieldsNode, type GhItemNode } from '../../src/sources/github-queries.js';
import type { Gql, TaskFilter } from '../../src/types.js';
import { combConfig, fakeGql, fakeLog, FILTER } from '../fakes.js';
import { listFilterOptions } from '../../src/sources/github.js';
import { itemNode, SOURCE as ROWS, T1, T2 } from '../read-model/fixtures.js';

// The GitHub adapter with a read model (#190): what each poll sends, and what a write stores
const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'].map((name) => ({ id: `O_${name}`, name }));
const FIELDS = { repositoryOwner: { projectV2: { id: 'PVT_1', field: { id: 'F_status', options: OPTIONS } } } };
const RATE = { limit: 5000, remaining: 4320, resetAt: '2026-10-13T13:00:00Z' };
const probeAt = (updatedAt: string): unknown => ({ rateLimit: { ...RATE, remaining: 4999 }, repositoryOwner: { projectV2: { updatedAt } } });
const page = (nodes: GhItemNode[]): unknown => ({ rateLimit: RATE, repositoryOwner: { projectV2: { fields: { nodes: [{ name: 'Status', dataType: 'SINGLE_SELECT', options: OPTIONS }] }, items: { pageInfo: { hasNextPage: false }, nodes } } } });
const node = (n: number, status: string, updatedAt = T1): GhItemNode => itemNode(n, status, updatedAt);
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

test('a poll that ran while a write was in flight does not keep its stamp: the poll after the write reads in full (#190)', async () => {
  const fake = fakeGql({ fields: FIELDS, setOption: {}, probe: probeAt(T1), items: page([node(1, 'Ready')]), relations: {} });
  let land: () => void = () => undefined;
  const landed = new Promise<void>((resolve) => { land = resolve; });
  // the mutation is sent, then held: GitHub has not answered when the poll below reads
  const gql: Gql = async (query, variables) => {
    const answer = await fake.gql(query, variables);
    if (fake.calls.at(-1)?.name === 'setOption') await landed;
    return answer;
  };
  const source = createSource(SPEC, { gql, items: await memoryStore() });
  await source.resolveFields();
  await source.listItems();
  const write = source.setColumn('PVTI_1', 'In progress');
  await source.listItems(); // a full read (the write cleared the stamp) of the item from before the write
  land();
  await write;
  fake.calls.length = 0;
  await source.listItems();
  assert.deepEqual(names(fake.calls), ['probe', 'items', 'relations']);
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

test('stored() answers the stored listing as the SourceItems listItems builds from it, with no gql call (#191)', async () => {
  const items = await memoryStore();
  const { gql } = fakeGql({ probe: probeAt(T1), items: page([node(1, 'Ready'), node(2, 'In progress')]), relations: {} });
  const listed = await createSource(SPEC, { gql, items }).listItems();
  const offline = fakeGql({}); // every call rejects: a restart with the model and no network
  const restarted = createSource(SPEC, { gql: offline.gql, items });
  assert.equal(listed.length, 2);
  assert.deepEqual(await restarted.stored?.(), listed);
  assert.deepEqual(offline.calls, []);
});

test('stored() answers [] with no item store, with no account, and for an @me owner it cannot resolve without the network (#191)', async () => {
  const { gql, calls } = fakeGql({});
  assert.deepEqual(await createSource(SPEC, { gql }).stored?.(), []);
  assert.deepEqual(await createSource(SPEC, { gql, items: { ...(await memoryStore()), source: async () => undefined } }).stored?.(), []);
  const mine = parseConfig(combConfig({ source: { type: 'github', owner: '@me', number: 6, filter: FILTER } }));
  assert.deepEqual(await createSource(sourceSpec(mine, mine.comb.sources[0]), { gql, items: await memoryStore() }).stored?.(), []);
  assert.deepEqual(calls, []);
});

// #424: 1, blocked by an open #9, lists 2 as its sub-issue; only 2 carries the hive label. The relations query answers the one kept task
const HIVE: TaskFilter = [{ field: 'label', op: 'any', values: ['hive'] }];
const specWith = (source: Record<string, unknown>) => {
  const c = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter: FILTER, ...source } }));
  return sourceSpec(c, c.comb.sources[0]);
};
const child = (status = 'Ready', updatedAt = T1): GhItemNode => itemNode(2, status, updatedAt, { labels: { nodes: [{ name: 'hive' }] } });
const family = (): GhItemNode[] => [
  itemNode(1, 'Ready', T1, {
    subIssuesSummary: { total: 1, completed: 0 }, subIssues: { nodes: [{ id: 'I_2', number: 2, state: 'OPEN' }] },
    blockedBy: { nodes: [{ number: 9, title: 'T9', state: 'OPEN', repository: { nameWithOwner: 'acme/r' } }] },
  }),
  child(),
];
const ANSWERED = { i0: { issue: { blocking: { nodes: [] } } } };

test('a poll stamps inheritedBlockedBy on a child whose parent the filter or epics: hide drops, from the wire and from the read model alike; a blocked: none rule drops that child (#424)', async () => {
  for (const spec of [specWith({ filter: HIVE }), specWith({ epics: 'hide' })]) {
    for (const items of [undefined, await memoryStore()]) {
      const { gql } = fakeGql({ probe: probeAt(T1), items: page(family()), relations: ANSWERED });
      const listed = await createSource(spec, { gql, ...(items === undefined ? {} : { items }) }).listItems();
      assert.deepEqual(listed.map((task) => [task.item.id, task.item.blockedBy, task.item.inheritedBlockedBy]), [['2', undefined, [{ id: '9', via: '1' }]]]);
    }
  }
  const free = specWith({ filter: [...HIVE, { field: 'blocked', op: 'none' }] });
  const { gql } = fakeGql({ items: page(family()), relations: ANSWERED });
  assert.deepEqual(await createSource(free, { gql }).listItems(), [], 'the blocked rule judges the inherited blocker too');
});

test('stored() stamps inheritedBlockedBy as listItems does (#424)', async () => {
  const items = await memoryStore();
  const spec = specWith({ filter: HIVE });
  const listed = await createSource(spec, { gql: fakeGql({ probe: probeAt(T1), items: page(family()), relations: ANSWERED }).gql, items }).listItems();
  const restored = await createSource(spec, { gql: fakeGql({}).gql, items }).stored?.();
  // stored() applies no filter (it shows the whole stored listing), so the parent is in it too; the child's entry is the poll's
  assert.deepEqual(restored?.find((task) => task.item.id === '2'), listed[0]);
  assert.deepEqual(restored?.find((task) => task.item.id === '2')?.item.inheritedBlockedBy, [{ id: '9', via: '1' }]);
});

test('a field write\'s re-read entry inherits its parent\'s open blockers from the last listing, the parent in it though the re-read is one item (#424)', async () => {
  const rereadChild = (status: string, updatedAt: string): GhItemFieldsNode => ({ ...child(status, updatedAt), project: { id: 'PVT_1', fields: { nodes: [STATUS_FIELD] } } });
  const source = createSource(SPEC, { gql: writeGql([rereadChild('Ready', T1), rereadChild('In review', T2)], family()) });
  await source.resolveFields();
  await source.listItems(); // the listing the re-read's tree is read over
  const written = await source.setField?.('PVTI_2', 'Status', 'In review');
  assert.deepEqual(written?.entry?.item.inheritedBlockedBy, [{ id: '9', via: '1' }]);
});

test('with a store, setColumn stores its re-read item as a write answer: a poll read before the write, with an older updatedAt, leaves the task in the written column (#191)', async () => {
  const before = node(1, 'Ready', T1); // the listing GitHub still served when the poll read it
  const source = createSource(SPEC, { gql: writeGql([reread('In review', T2)], [before]), items: await memoryStore() });
  await source.resolveFields();
  await source.setColumn('PVTI_1', 'In review');
  assert.deepEqual((await source.listItems()).map((task) => [task.item.itemId, task.column]), [['PVTI_1', 'In review']]);
});

test('without a store setColumn sends only the mutation; with one, a failed re-read is logged and the write still resolves (#191)', async () => {
  const { gql, calls } = fakeGql({ fields: FIELDS, setOption: {} });
  const bare = createSource(SPEC, { gql });
  await bare.resolveFields();
  await bare.setColumn('PVTI_1', 'In review');
  assert.deepEqual(names(calls), ['fields', 'setOption']);

  const { log, lines } = fakeLog();
  const stored = createSource(SPEC, { gql: writeGql([], []), items: await memoryStore(), log }); // ITEM_FIELDS answers no node
  await stored.resolveFields();
  await stored.setColumn('PVTI_1', 'In review');
  assert.ok(lines.some((l) => l.startsWith('ERROR item PVTI_1: the column write was not re-read for the read model')), lines.join('\n'));
});

// #291: gh's words with the network off, as ghExec rejects with them
const GH_OFFLINE = 'gh api graphql: error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';

test('offline at boot, the adapter resolveSources deferred answers stored() from the read model, its listItems rejects while offline, and once online it reads the Status field once, then lists as before (#291)', async () => {
  const items = await memoryStore();
  const nodes = page([node(1, 'Ready'), node(2, 'In progress')]);
  const listed = await createSource(SPEC, { gql: fakeGql({ probe: probeAt(T1), items: nodes, relations: {} }).gql, items }).listItems();
  assert.equal(listed.length, 2);
  let isOnline = false;
  const online = fakeGql({ fields: FIELDS, probe: probeAt(T1), items: nodes, relations: {} });
  const gql: Gql = (query, variables) => (isOnline ? online.gql(query, variables) : Promise.reject(new Error(GH_OFFLINE)));
  const source = (await resolveSources(new Map([['board', createSource(SPEC, { gql, items })]]), { deferOffline: true })).get('board');
  assert.ok(source);
  assert.deepEqual(await source.stored?.(), listed, 'the boot read needs no network');
  await assert.rejects(source.listItems(), { message: GH_OFFLINE });
  isOnline = true;
  assert.deepEqual(await source.listItems(), listed);
  assert.deepEqual(await source.listItems(), listed);
  assert.equal(names(online.calls)[0], 'fields', 'the resolve runs before the first listing');
  assert.equal(names(online.calls).filter((name) => name === 'fields').length, 1, 'and only once');
});

test('listFilterOptions reads the stored listing when there is one, so the settings form pays no items read (#282)', async () => {
  const items = await memoryStore();
  const { gql } = fakeGql({ probe: probeAt(T1), items: page([itemNode(1, 'Ready', T1, { labels: { nodes: [{ name: 'hive' }] } })]), relations: {} });
  await createSource(SPEC, { gql, items }).listItems();
  const settings = fakeGql({ selectFields: { repositoryOwner: { projectV2: { fields: { nodes: [] } } } } });
  assert.deepEqual((await listFilterOptions('acme', 6, settings.gql, items)).labels, ['hive']);
  assert.deepEqual(names(settings.calls), ['selectFields'], 'no items page');
});
