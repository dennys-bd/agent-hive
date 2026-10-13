import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel } from '../../src/read-model/db.js';
import { itemRow, readListing, type ItemStore, type ListingKey } from '../../src/read-model/items.js';
import { createItemsSync, FULL_READ_MAX_AGE_MS, readProbe, type ItemsSyncDeps } from '../../src/sources/github-items-sync.js';
import { PROBE, type GhIssueRelations, type GhItemNode } from '../../src/sources/github-queries.js';
import type { Gql, SourceItem } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { SOURCE, T1, T2 } from '../read-model/fixtures.js';

// #190: the probe-or-read decision, the store and read-back, and a write's answer, over an in-memory model
const KEY: ListingKey = { source: SOURCE, project: 'acme/6', scope: 'acme/6' };
const ISSUE: GhIssueRelations = { blockedBy: { nodes: [] }, blocking: { nodes: [] }, subIssues: { nodes: [] } };
const node = (n: number, updatedAt = T1): GhItemNode => ({
  id: `PVTI_${n}`, updatedAt, fieldValueByName: { name: 'Ready' },
  content: { __typename: 'Issue', id: `I_${n}`, number: n, url: `https://github.com/acme/r/issues/${n}`, repository: { nameWithOwner: 'acme/r' } },
});
const task = (n: number): SourceItem => ({ item: { itemId: `PVTI_${n}`, id: String(n), title: `T${n}`, body: '', url: `https://github.com/acme/r/issues/${n}` }, column: 'Ready' });

// A sync with every edge recorded: the probe answers `stamps` in order and repeats the last; the clock is the test's
async function harness(stamps: string[], extra: Partial<ItemsSyncDeps> = {}, source: () => Promise<string | undefined> = async () => SOURCE) {
  const { db } = await openReadModel(':memory:');
  const store: ItemStore = { db, source, notify: () => undefined };
  const clock = { now: 0 };
  const calls: string[] = [];
  const queue = [...stamps];
  const deps: ItemsSyncDeps = {
    store, now: () => clock.now,
    probe: async () => { calls.push('probe'); return (queue.length > 1 ? queue.shift() : queue[0]) ?? ''; },
    listNodes: async () => { calls.push('read'); return [node(1), node(2)]; },
    kept: (nodes) => nodes.map((n) => task(Number(n.id.slice('PVTI_'.length)))),
    fetchRelations: async (tasks) => { calls.push(`relations ${tasks.length}`); return new Map(tasks.map((t) => [t.item.itemId, ISSUE])); },
    ...extra,
  };
  return { sync: createItemsSync(deps), db, clock, calls };
}

test('the probe answers the project\'s updatedAt and the quota reading; a null owner or project is the source not being there (#190)', async () => {
  const rate = { limit: 5000, remaining: 4999, resetAt: T2 };
  const asked: unknown[] = [];
  const answering = (data: unknown): Gql => async (query, variables) => { asked.push([query === PROBE, variables]); return data; };
  const variables = { login: 'acme', number: 6 };
  assert.deepEqual(await readProbe(answering({ rateLimit: rate, repositoryOwner: { projectV2: { updatedAt: T1 } } }), variables, 'gone'), { updatedAt: T1, rateLimit: rate });
  await assert.rejects(readProbe(answering({ repositoryOwner: null }), variables, 'gone'), { message: 'gone' });
  await assert.rejects(readProbe(answering({ repositoryOwner: { projectV2: null } }), variables, 'gone'), { message: 'gone' });
  assert.deepEqual(asked[0], [true, variables]);
});

test('list reads in full on the first poll, a moved probe, a cleared stamp, another scope or FULL_READ_MAX_AGE_MS past; else it only probes (#190)', async () => {
  const { sync, clock, calls } = await harness(['S1', 'S1', 'S2']);
  const sent = async (key: ListingKey = KEY): Promise<string[]> => {
    calls.length = 0;
    await sync.list(key);
    return [...calls];
  };
  const full = ['probe', 'read', 'relations 2'];
  assert.deepEqual(await sent(), full, 'the first poll');
  assert.deepEqual(await sent(), ['probe'], 'unmoved');
  assert.deepEqual(await sent(), full, 'moved');
  sync.clear();
  assert.deepEqual(await sent(), full, 'cleared by a write');
  clock.now += FULL_READ_MAX_AGE_MS - 1;
  assert.deepEqual(await sent(), ['probe']);
  clock.now += 1;
  assert.deepEqual(await sent(), full, 'the forced full read');
  assert.deepEqual(await sent({ ...KEY, scope: 'acme/6 label:"hive"' }), full, 'another scope has nothing stored yet');
});

test('list answers the listing read back from the model, each node with its stored relations (#190)', async () => {
  const { sync } = await harness(['S1']);
  const read = await sync.list(KEY);
  assert.deepEqual(read.nodes.map((n) => n.id), ['PVTI_1', 'PVTI_2']);
  assert.deepEqual(read.relations.get('PVTI_1'), ISSUE);
});

test('a failed relations query stores nothing and rejects the poll; the next poll reads in full again (#190)', async () => {
  let isRefused = true;
  const fetchRelations = async (tasks: SourceItem[]): Promise<Map<string, GhIssueRelations | null>> => {
    if (isRefused) throw new Error('relations refused');
    return new Map(tasks.map((t) => [t.item.itemId, null]));
  };
  const { sync, db, calls } = await harness(['S1'], { fetchRelations });
  await assert.rejects(sync.list(KEY), { message: 'relations refused' });
  assert.deepEqual(readListing(db, KEY).nodes, []);
  isRefused = false;
  calls.length = 0;
  await sync.list(KEY);
  assert.deepEqual(calls, ['probe', 'read']);
});

test('relate fetches only the kept tasks with no stored relations, and stores what it read (#190)', async () => {
  const { sync, db, calls } = await harness(['S1']);
  await sync.list(KEY);
  db.setItemRelations(SOURCE, 'PVTI_2', null);
  calls.length = 0;
  const related = await sync.relate(SOURCE, [task(1), task(2)], new Map([['PVTI_1', ISSUE], ['PVTI_2', undefined]]));
  assert.deepEqual(calls, ['relations 1']);
  assert.deepEqual(readListing(db, KEY).relations.get('PVTI_2'), ISSUE);
  assert.ok(related.every((t) => t.item.blockers !== undefined), 'both read: "none" both ways');
});

test('answer stores a write\'s re-read item with origin write and the relations its entry read (#190)', async () => {
  const { sync, db } = await harness(['S1']);
  await sync.list(KEY);
  await sync.answer({ ...node(1, T2), fieldValueByName: { name: 'In review' } }, new Map([['PVTI_1', null]]), KEY.project);
  const back = readListing(db, KEY);
  assert.deepEqual([back.nodes[0]?.fieldValueByName?.name, back.relations.get('PVTI_1')], ['In review', null]);
  assert.equal(db.upsertItem(itemRow(SOURCE, KEY.project, node(1, T2)), 'sync'), false, 'a poll read before it, in its second, does not undo it');
});

test('answer stores nothing without a login, and logs a failure instead of throwing it (#190)', async () => {
  const none = await harness(['S1'], {}, async () => undefined);
  await none.sync.answer(node(1), new Map(), KEY.project);
  assert.equal(none.db.upsertItem(itemRow(SOURCE, KEY.project, node(1)), 'sync'), true, 'no row was there');
  const { log, lines } = fakeLog();
  const failing = await harness(['S1'], { log }, async () => { throw new Error('no credentials'); });
  await failing.sync.answer(node(1), new Map(), KEY.project);
  assert.deepEqual(lines, ["ERROR source acme/6: a write's answer was not stored in the read model: no credentials"]);
});
