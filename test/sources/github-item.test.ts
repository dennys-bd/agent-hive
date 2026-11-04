import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel } from '../../src/read-model/db.js';
import type { ItemStore } from '../../src/read-model/items.js';
import type { RefetchOutcome } from '../../src/read-model/loop.js';
import type { IssueRow } from '../../src/read-model/rows.js';
import { readOneItem, type ItemReadContext } from '../../src/sources/github-item.js';
import type { GhItemFieldsNode, GhItemNode } from '../../src/sources/github-queries.js';
import { statusOf } from '../../src/sources/github-tree.js';
import type { Gql } from '../../src/types.js';
import { fakeGql } from '../fakes.js';
import { ISSUE_ROW, issueRow, itemNode, SOURCE as ROWS, T1 } from '../read-model/fixtures.js';

// #567: one item past the listing. The context's entry and isListed stand in for the adapter's (the adapter's own are tested below)
const URL1 = 'https://github.com/acme/r/issues/1';
const URL12 = 'https://github.com/acme/hive/issues/12';
const names = (calls: { name: string }[]): string[] => calls.map((c) => c.name);
const on = (node: GhItemNode, projectId = 'PVT_1'): GhItemFieldsNode => ({ ...node, project: { id: projectId } });
const ISSUE1 = { itemId: 'PVTI_1', id: '1', title: 'T1', body: 'body 1', url: URL1, createdAt: T1 };

function ctxOf(gql: Gql, extra: Partial<ItemReadContext> = {}): ItemReadContext {
  return {
    gql, projectId: 'PVT_1', isListed: () => true,
    entry: async (node) => { const column = statusOf(node); return column === undefined ? undefined : { item: { ...ISSUE1, itemId: node.id }, column }; },
    ...extra,
  };
}

async function modelStore(outcome: RefetchOutcome, rows: IssueRow[] = []): Promise<{ store: ItemStore; asked: string[] }> {
  const { db } = await openReadModel(':memory:');
  for (const row of rows) db.upsertIssue(row, 'sync');
  const asked: string[] = [];
  const refetch = async (repository: string, number: number): Promise<RefetchOutcome> => { asked.push(`${repository}#${number}`); return outcome; };
  return { asked, store: { db, source: async () => ROWS, notify: () => undefined, refetch } };
}

test('an open issue on the Project answers listing or filter as isListed says, with the entry (#567)', async () => {
  const { gql, calls } = fakeGql({ itemFields: { node: on(itemNode(1, 'Done')) } });
  assert.deepEqual(await readOneItem(ctxOf(gql), 'PVTI_1', URL1), { reason: 'listing', entry: { item: ISSUE1, column: 'Done' } });
  assert.deepEqual(await readOneItem(ctxOf(gql, { isListed: () => false }), 'PVTI_1', URL1), { reason: 'filter', entry: { item: ISSUE1, column: 'Done' } });
  assert.deepEqual(names(calls), ['itemFields', 'itemFields']);
});

test('a closed issue on the Project answers closed with its column, before any entry (#567)', async () => {
  const { gql } = fakeGql({ itemFields: { node: on(itemNode(1, 'Done', T1, { state: 'CLOSED' })) } });
  const entry = async (): Promise<undefined> => { throw new Error('a closed item builds no entry'); };
  assert.deepEqual(await readOneItem(ctxOf(gql, { entry }), 'PVTI_1', URL1), { reason: 'closed', item: ISSUE1, column: 'Done' });
});

test('an open issue on the Project with no Status value answers project (#567)', async () => {
  const { gql } = fakeGql({ itemFields: { node: on(itemNode(1, 'Ready', T1, {}, { fieldValueByName: null })) } });
  assert.deepEqual(await readOneItem(ctxOf(gql), 'PVTI_1', URL1), { reason: 'project', item: ISSUE1 });
});

test('a draft node, and a malformed url off the Project, answer gone with no issue read (#567)', async () => {
  const draft = fakeGql({ itemFields: { node: on(itemNode(1, 'Ready', T1, { __typename: 'DraftIssue' })) } });
  assert.deepEqual(await readOneItem(ctxOf(draft.gql), 'PVTI_1', URL1), { reason: 'gone' });
  const malformed = fakeGql({ itemFields: { node: null } });
  assert.deepEqual(await readOneItem(ctxOf(malformed.gql), 'PVTI_1', 'https://github.com/acme/hive/pull/12'), { reason: 'gone' });
  assert.deepEqual(names(malformed.calls), ['itemFields']);
});

test('off the Project with a store: the refetch of owner/repo and the number, then the row answers project or closed under the passed itemId (#567)', async () => {
  for (const node of [null, on(itemNode(1, 'Ready'), 'PVT_other')]) {
    const { gql, calls } = fakeGql({ itemFields: { node } });
    const open = await modelStore('changed', [issueRow(12, T1, { state: 'open', closedAt: null })]);
    assert.deepEqual(await readOneItem(ctxOf(gql, { store: open.store }), 'PVTI_1', URL12), {
      reason: 'project', item: { itemId: 'PVTI_1', id: '12', title: 'T12', body: 'b', url: URL12, createdAt: ISSUE_ROW.createdAt },
    });
    assert.deepEqual(open.asked, ['acme/hive#12']);
    assert.deepEqual(names(calls), ['itemFields'], 'never the listing, never the issue query');
  }
  const { gql } = fakeGql({ itemFields: { node: null } });
  const closed = await modelStore('unchanged', [ISSUE_ROW]);
  assert.equal((await readOneItem(ctxOf(gql, { store: closed.store }), 'PVTI_1', URL12)).reason, 'closed');
  const cooled = await modelStore('skipped', [issueRow(12, T1, { state: 'open', closedAt: null })]);
  assert.equal((await readOneItem(ctxOf(gql, { store: cooled.store }), 'PVTI_1', URL12)).reason, 'project', 'the cooldown reads the row');
});

test('off the Project with a store: gone, or no row, answers gone; failed rejects (#567)', async () => {
  const { gql } = fakeGql({ itemFields: { node: null } });
  assert.deepEqual(await readOneItem(ctxOf(gql, { store: (await modelStore('gone', [ISSUE_ROW])).store }), 'PVTI_1', URL12), { reason: 'gone' });
  assert.deepEqual(await readOneItem(ctxOf(gql, { store: (await modelStore('skipped')).store }), 'PVTI_1', URL12), { reason: 'gone' });
  await assert.rejects(readOneItem(ctxOf(gql, { store: (await modelStore('failed')).store }), 'PVTI_1', URL12), /acme\/hive#12 could not be read/);
});

test('off the Project without a store, or with a store with no login: one ISSUE_BY_NUMBER call; open, closed, null (#567)', async () => {
  const issue = (state: string) => ({ repository: { issue: { number: 12, title: 'T12', body: 'b', url: URL12, state, createdAt: T1 } } });
  const noLogin = { ...(await modelStore('changed')).store, source: async () => undefined };
  for (const store of [undefined, noLogin]) {
    const { gql, calls } = fakeGql({ itemFields: { node: null }, issueByNumber: [issue('OPEN'), issue('CLOSED'), { repository: { issue: null } }] });
    const ctx = ctxOf(gql, store === undefined ? {} : { store });
    const item = { itemId: 'PVTI_1', id: '12', title: 'T12', body: 'b', url: URL12, createdAt: T1 };
    assert.deepEqual(await readOneItem(ctx, 'PVTI_1', URL12), { reason: 'project', item });
    assert.deepEqual(await readOneItem(ctx, 'PVTI_1', URL12), { reason: 'closed', item });
    assert.deepEqual(await readOneItem(ctx, 'PVTI_1', URL12), { reason: 'gone' });
    assert.deepEqual(calls.filter((c) => c.name === 'issueByNumber').map((c) => c.variables), Array(3).fill({ owner: 'acme', name: 'hive', number: 12 }));
  }
});
