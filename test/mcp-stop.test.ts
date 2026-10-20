import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BLOCK_MESSAGE, BLOCK_WITH_REASON_MESSAGE, CANNOT_BLOCK_MESSAGE, mountMcp, NOT_BLOCKED_MESSAGE } from '../src/mcp.js';
import { initialState } from '../src/orchestrator.js';
import type { RelateOutcome } from '../src/server-blockers.js';
import type { RecordInput } from '../src/events.js';
import { MCP_DEFAULTS } from '../src/types.js';
import type { BlockerChange, Config, HiveEvent, State, Task, Worker } from '../src/types.js';
import { fakeEvents } from './fakes.js';
import { activityIdOf, withWork } from './fixtures/work.js';

// hive_stop with block (#294) over a fake relate: a ref in `refused` is refused, one in `closed` is written closed, any other is written open
// and gates the task as relate's itemRead would
const ITEM_ID = 'gh:I1';
const TASK: Task = { item: { itemId: ITEM_ID, id: '1', title: 'T', body: '', url: 'https://github.com/acme/r/issues/1', source: 'gh' }, stage: 'fila', boardColumn: 'Ready', auto: true };
const REFUSED: RelateOutcome = { refusal: { status: 404, error: 'no such issue or task to relate', code: 'blockers.unknownRef' } };

interface Harness { client: Client; asked: BlockerChange[]; dispatched: HiveEvent[]; records: RecordInput[]; state(): State }
interface Options { refused?: string[]; closed?: string[]; canRelate?: boolean }

async function harness(t: TestContext, { refused = [], closed = [], canRelate = true }: Options = {}): Promise<Harness> {
  const workers: Worker[] = [{ id: 'w1', runId: 'p1', status: 'working', activityId: activityIdOf(ITEM_ID) }];
  let state: State = withWork({ ...initialState(1), tasks: [TASK], workers }, ITEM_ID, { workerId: 'w1' });
  const asked: BlockerChange[] = [];
  const dispatched: HiveEvent[] = [];
  const { events, records } = fakeEvents();
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const relate = async (_itemId: string, change: BlockerChange): Promise<RelateOutcome> => {
    asked.push(change);
    if (refused.includes(change.ref)) return REFUSED;
    const open = !closed.includes(change.ref);
    if (open) state = { ...state, tasks: state.tasks.map((c) => ({ ...c, item: { ...c.item, blockedBy: [...(c.item.blockedBy ?? []), change.ref] } })) };
    return { blockers: { blockedBy: [{ id: change.ref, title: '', state: open ? 'open' : 'closed' }], blocking: [] } };
  };
  const app = express().use(express.json());
  mountMcp(app, {
    exec: async () => ({ stdout: '' }), live: () => ({ state, config: { mcp: MCP_DEFAULTS } as Config, sources: new Map() }), poll: async () => undefined,
    dispatch: async (event) => { dispatched.push(event); return []; }, canClose: () => true, relate, canRelate: () => canRelate,
    reviews: { read: unused, update: unused }, notifyReview: () => undefined, localReviews: { read: unused, update: unused }, notifyLocalReview: () => undefined, events, memory: { read: unused, update: unused },
  });
  const http = app.listen(0);
  t.after(() => http.close());
  await once(http, 'listening');
  const client = new Client({ name: 'hive-test', version: '0.0.0' });
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/hooks/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-hive-pty': 'p1' } } }));
  t.after(() => client.close());
  return { client, asked, dispatched, records, state: () => state };
}

async function stopWith(client: Client, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name: 'hive_stop', arguments: args })) as CallToolResult;
  const [first] = result.content;
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
}
const reasons = (records: RecordInput[]): unknown[] => records.flatMap((r) => (r.event === 'mcp.call' ? [r.reason] : []));

test('block with reason or duplicateOf, a malformed block and a source that cannot relate are refused before any write; nothing stops (#294)', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await stopWith(h.client, { block: [12], reason: 'wontDo' }), { text: BLOCK_WITH_REASON_MESSAGE, isError: true });
  assert.deepEqual(await stopWith(h.client, { block: [12], duplicateOf: 7 }), { text: BLOCK_WITH_REASON_MESSAGE, isError: true });
  for (const block of [[], [0], [1.5], [' '], Array.from({ length: 11 }, (_, i) => i + 1)]) {
    assert.deepEqual(await stopWith(h.client, { block }), { text: BLOCK_MESSAGE, isError: true }, JSON.stringify(block));
  }
  const bare = await harness(t, { canRelate: false });
  assert.deepEqual(await stopWith(bare.client, { block: [12] }), { text: CANNOT_BLOCK_MESSAGE, isError: true });
  assert.deepEqual([h.asked, h.dispatched, bare.asked, bare.dispatched], [[], [], [], []]);
  assert.deepEqual(reasons(h.records), ['block_with_reason', 'block_with_reason', ...Array(5).fill('block_refused')]);
  assert.deepEqual(reasons(bare.records), ['cannot_block']);
});

test('each ref is written in order as an add of blockedBy, then the stop is dispatched with block (#294)', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await stopWith(h.client, { block: [12, ' #13 ', 'acme/site#14'] }), { text: 'ok', isError: false });
  assert.deepEqual(h.asked, [{ action: 'add', kind: 'blockedBy', ref: '12' }, { action: 'add', kind: 'blockedBy', ref: '#13' }, { action: 'add', kind: 'blockedBy', ref: 'acme/site#14' }]);
  assert.deepEqual(h.dispatched, [{ type: 'stop', ptyId: 'p1', block: true }]);
  assert.deepEqual(reasons(h.records), [undefined]);
});

test('a refused ref refuses the call with its words, writes no later ref, stops nothing and keeps the earlier writes (#294)', async (t) => {
  const h = await harness(t, { refused: ['99'] });
  const answer = await stopWith(h.client, { block: [12, 99, 14] });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /99: no such issue or task to relate/);
  assert.deepEqual([h.asked.map((c) => c.ref), h.dispatched], [['12', '99'], []]);
  assert.deepEqual(h.state().tasks[0].item.blockedBy, ['12'], 'no rollback: the written relation is true regardless');
  assert.deepEqual(reasons(h.records), ['block_refused']);
});

test('every blocker already closed: the relations are written, the call is refused not_blocked and the session runs on (#294)', async (t) => {
  const h = await harness(t, { closed: ['5', '6'] });
  assert.deepEqual(await stopWith(h.client, { block: [5, 6] }), { text: NOT_BLOCKED_MESSAGE, isError: true });
  assert.deepEqual([h.asked.length, h.dispatched], [2, []]);
  assert.deepEqual(reasons(h.records), ['not_blocked']);
});
