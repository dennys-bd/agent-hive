import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { drafter, serial } from '../../src/benchmark/drafts.js';
import { type BenchmarkToolDeps, registerBenchmarkDraftTool, registerBenchmarkGetTool, registerBenchmarkListTool } from '../../src/mcp-benchmark.js';
import type { Worker } from '../../src/types.js';
import { type BenchDeps, benchDeps } from './bench-server.js';
import { benchExperiment, ISOLATION } from './fixtures.js';

const PTY = 'pty-1';
const WORKER: Worker = { id: 'w1', runId: PTY, status: 'working', agent: 'codex', launch: { model: 'gpt-5' }, freeSession: true };

const toolDeps = (bench: BenchDeps): BenchmarkToolDeps => ({
  live: () => ({ state: { ...bench.state(), workers: [WORKER] }, config: bench.config, sources: new Map() }),
  facts: { write: () => undefined },
  benchmark: drafter({ ...bench.deps, queue: serial(), log: bench.log, live: () => ({ config: bench.config, experiments: bench.state().benchmark.experiments }) }),
});

async function connect(t: TestContext, deps: BenchmarkToolDeps, header: string = PTY): Promise<Client> {
  const server = new McpServer({ name: 'hive', version: '0.0.0' });
  for (const register of [registerBenchmarkListTool, registerBenchmarkGetTool, registerBenchmarkDraftTool]) register(server, deps, header);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'hive-test', version: '0.0.0' });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = result.content;
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
}

test('benchmark_list and benchmark_get answer the experiments and one config as JSON; an unknown id is a tool error (#478)', async (t) => {
  const bench = await benchDeps(t, { experiments: [benchExperiment(), benchExperiment({ id: 'exp-2', name: 'Two', archived: true })] });
  const client = await connect(t, toolDeps(bench));
  assert.deepEqual(JSON.parse((await call(client, 'benchmark_list')).text), [
    { id: 'exp-1', name: 'Skills', status: 'draft', workspace: 'bench' }, { id: 'exp-2', name: 'Two', status: 'draft', workspace: 'bench', archived: true },
  ]);
  const e = benchExperiment();
  assert.deepEqual(JSON.parse((await call(client, 'benchmark_get', { id: 'exp-1' })).text), {
    id: e.id, name: e.name, status: e.status, workspace: e.workspace, base: e.base, arms: e.arms, seed: e.seed, pace: e.pace, isolation: e.isolation, blindness: e.blindness, evaluation: e.evaluation,
  });
  assert.deepEqual(await call(client, 'benchmark_get', { id: 'nope' }), { text: 'no experiment nope', isError: true });
});

test("benchmark_draft creates from a workspace and from `from`, and replaces a draft keeping its createdBy; createdBy names the worker's agent and model (#478)", async (t) => {
  const bench = await benchDeps(t, { experiments: [benchExperiment(), benchExperiment({ id: 'exp-2' })] });
  const client = await connect(t, toolDeps(bench));
  const find = (id: string) => bench.state().benchmark.experiments.find((e) => e.id === id);
  const fresh = JSON.parse((await call(client, 'benchmark_draft', { workspace: 'bench', name: 'Fresh' })).text) as { id: string };
  assert.deepEqual([find(fresh.id)?.name, find(fresh.id)?.createdBy], ['Fresh', { kind: 'mcp', agent: 'codex', model: 'gpt-5' }]);
  const copy = JSON.parse((await call(client, 'benchmark_draft', { from: 'exp-1' })).text) as { id: string };
  assert.equal(find(copy.id)?.name, 'Skills · copy');
  assert.deepEqual(JSON.parse((await call(client, 'benchmark_draft', { id: 'exp-2', name: 'Edited' })).text), { id: 'exp-2' });
  assert.deepEqual([find('exp-2')?.name, find('exp-2')?.createdBy], ['Edited', { kind: 'user' }]);
  assert.deepEqual(bench.events.map((event) => event.type), ['benchmarkCreated', 'benchmarkCreated', 'benchmarkEdited']);
});

test('benchmark_draft answers every zod issue one per line and changes nothing; a non-draft, a draft with rounds and a perArm key naming no arm are refused (#478)', async (t) => {
  const bench = await benchDeps(t, { experiments: [benchExperiment({ status: 'done' }), benchExperiment({ id: 'exp-2', rounds: [{ n: 1, runs: [] }] })] });
  const client = await connect(t, toolDeps(bench));
  const before = await readdir(join(bench.home, 'benchmark'));
  const shape = await call(client, 'benchmark_draft', { workspace: 'bench', pace: { pairs: 0 }, extra: 1 });
  assert.equal(shape.isError, true);
  assert.ok(shape.text.split('\n').some((line) => line.startsWith('pace.pairs: ')));
  assert.ok(shape.text.split('\n').some((line) => /^input: .*extra/.test(line)));
  assert.match((await call(client, 'benchmark_draft', { id: 'exp-1', name: 'x' })).text, /exp-1 is not a draft without rounds/);
  assert.match((await call(client, 'benchmark_draft', { id: 'exp-2', name: 'x' })).text, /exp-2 is not a draft without rounds/);
  assert.equal((await call(client, 'benchmark_draft', { workspace: 'bench', isolation: { ...ISOLATION, env: { all: {}, perArm: { ghost: {} } } } })).text, 'isolation.env.perArm: ghost is no arm of the draft');
  assert.deepEqual(await readdir(join(bench.home, 'benchmark')), before);
  assert.deepEqual(bench.events, []);
});

test('a call from no live worker answers unknown worker and drafts nothing (#478)', async (t) => {
  const bench = await benchDeps(t);
  const client = await connect(t, toolDeps(bench), 'ghost');
  for (const [name, args] of [['benchmark_list', {}], ['benchmark_get', { id: 'x' }], ['benchmark_draft', { workspace: 'bench' }]] as const) {
    assert.deepEqual(await call(client, name, args), { text: 'unknown worker', isError: true });
  }
  assert.deepEqual(bench.events, []);
});