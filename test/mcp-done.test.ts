import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { activityOf, resultOf } from '../src/activities.js';
import { mountMcp } from '../src/mcp.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { RecordInput } from '../src/facts.js';
import { MCP_DEFAULTS } from '../src/types.js';
import type { Config, HiveEvent, Stage, State, Task, Transition, Worker } from '../src/types.js';
import { fakeFacts } from './fakes.js';
import { activityIdOf, withWork } from './fixtures/work.js';

// hive_done on a task in a wait for CI whose only exit is passed (#339). dispatch runs the real reducer, so the test reads what the call left
const ITEM_ID = 'gh:I1';
const TASK: Task = { item: { itemId: ITEM_ID, id: '1', title: 'T', body: '', url: 'https://github.com/acme/r/issues/1', source: 'gh' }, stage: 'CI', boardColumn: 'Ready', auto: true };
const STAGES: Stage[] = [{ name: 'CI', from: {}, action: 'waitForCi' }];
const TRANSITIONS: Transition[] = [{ from: 'CI', to: 'end', when: 'verdict', verdict: 'passed' }];
const NO_EXIT = 'The task is in stage `CI`, which has no transition for `done`: no stage ended.';
const ASK = 'Ask the user what to do next with hive_ask.';
const DOCS_PR = 'https://github.com/acme/d/pull/2';

type McpCall = Extract<RecordInput, { event: 'mcp.call' }>;
interface Harness { client: Client; dispatched: HiveEvent[]; records: RecordInput[]; state(): State }

async function harness(t: TestContext, freeSession = true, stages: Stage[] = STAGES): Promise<Harness> {
  const workers: Worker[] = [{ id: 'w1', runId: 'p1', status: 'working', activityId: activityIdOf(ITEM_ID), ...(freeSession ? { freeSession: true } : {}) }];
  let state: State = withWork({ ...initialState(1), stages, transitions: TRANSITIONS, tasks: [TASK], workers }, ITEM_ID);
  const dispatched: HiveEvent[] = [];
  const { facts, records } = fakeFacts();
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const app = express().use(express.json());
  mountMcp(app, {
    exec: async () => ({ stdout: '' }), live: () => ({ state, config: { mcp: MCP_DEFAULTS } as Config, sources: new Map() }), poll: async () => undefined,
    dispatch: async (event) => { dispatched.push(event); state = reduce(state, event).state; return []; }, canClose: () => true, relate: unused, canRelate: () => false,
    reviews: { read: unused, update: unused }, notifyReview: () => undefined, localReviews: { read: unused, update: unused }, notifyLocalReview: () => undefined, facts, memory: { read: unused, update: unused }, benchmark: { draft: unused },
  });
  const http = app.listen(0);
  t.after(() => http.close());
  await once(http, 'listening');
  const client = new Client({ name: 'hive-test', version: '0.0.0' });
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/hooks/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-hive-pty': 'p1' } } }));
  t.after(() => client.close());
  return { client, dispatched, records, state: () => state };
}

async function done(client: Client, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name: 'hive_done', arguments: args })) as CallToolResult;
  const [first] = result.content;
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
}

test('hive_done from a free session in a stage with no exit for it is refused with no_transition, still dispatches done, and records its result (#339)', async (t) => {
  const { client, dispatched, records, state } = await harness(t);
  assert.deepEqual(await done(client, { result: { docsPr: DOCS_PR } }), { text: `${NO_EXIT} Your result was recorded. ${ASK}`, isError: true });
  assert.deepEqual(await done(client), { text: `${NO_EXIT} ${ASK}`, isError: true }, 'no result: nothing said about one');
  assert.deepEqual(dispatched.map((e) => e.type), ['done', 'done']);
  const live = activityOf(state(), ITEM_ID);
  assert.deepEqual([state().tasks[0].stage, live?.stopped, live?.error, resultOf(state(), ITEM_ID)?.docsPr], ['CI', undefined, undefined, DOCS_PR]);
  const calls = records.filter((r): r is McpCall => r.event === 'mcp.call');
  assert.deepEqual(calls.map((c) => [c.tool, c.level, c.outcome, c.reason]), [['hive_done', 'warn', 'refused', 'no_transition'], ['hive_done', 'warn', 'refused', 'no_transition']]);
});

test('hive_done from a stage run in the same stage answers ok as before: #134 halts it (#339)', async (t) => {
  const { client, dispatched } = await harness(t, false);
  assert.deepEqual(await done(client), { text: 'ok', isError: false });
  assert.deepEqual(dispatched.map((e) => e.type), ['done']);
});

test('hive_done with no verdict in an agent stage with verdicts and no done exit is refused with bad_verdict, dispatching nothing, in a stage run and a free session (#493)', async (t) => {
  const route: Stage[] = [{ name: 'CI', from: {}, prompt: '/route', verdicts: ['leaf', 'split'] }];
  for (const freeSession of [false, true]) {
    const { client, dispatched, records } = await harness(t, freeSession, route);
    assert.deepEqual(await done(client), { text: 'verdict is missing: pass one of this stage\'s: leaf, split', isError: true });
    assert.deepEqual(dispatched, [], 'the run goes on');
    assert.deepEqual(records.filter((r): r is McpCall => r.event === 'mcp.call').map((c) => c.reason), ['bad_verdict']);
  }
});
