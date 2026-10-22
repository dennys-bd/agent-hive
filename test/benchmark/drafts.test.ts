import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createEmptyExperiment, duplicateExperiment, editSections, isRefusal, serial } from '../../src/benchmark/drafts.js';
import { benchDeps } from './bench-server.js';
import { benchExperiment } from './fixtures.js';

const USER = { kind: 'user' } as const;
const MCP = { kind: 'mcp', agent: 'claude', model: 'opus' } as const;
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

test('createEmptyExperiment answers the draft it dispatched; an unknown workspace is a 404 refusal that writes nothing (#478)', async (t) => {
  const bench = await benchDeps(t);
  const made = await createEmptyExperiment(bench.ctx(), { workspace: 'bench', createdBy: USER });
  assert.ok(!isRefusal(made));
  assert.deepEqual(bench.state().benchmark.experiments, [made]);
  assert.ok(await exists(bench.dir(made.id)));
  assert.deepEqual(await createEmptyExperiment(bench.ctx(), { workspace: 'ghost', createdBy: USER }), { status: 404, error: 'unknown_workspace', message: 'no workspace ghost' });
  assert.equal(bench.state().benchmark.experiments.length, 1);
});

test('duplicateExperiment copies with the createdBy it is given; an unknown source is a 404 refusal (#478)', async (t) => {
  const bench = await benchDeps(t, { experiments: [benchExperiment()] });
  const copy = await duplicateExperiment(bench.ctx(), 'exp-1', MCP);
  assert.ok(!isRefusal(copy));
  assert.deepEqual([copy.name, copy.createdBy, copy.seedHash], ['Skills · copy', MCP, benchExperiment().seedHash]);
  assert.deepEqual(await duplicateExperiment(bench.ctx(), 'nope', USER), { status: 404, error: 'unknown_experiment', message: 'no experiment nope' });
});

test('editSections answers the id it edited, or the seed-workspace refusal (#478)', async (t) => {
  const draft = benchExperiment();
  const bench = await benchDeps(t, { experiments: [draft] });
  assert.deepEqual(await editSections(bench.ctx(), draft, { seed: { ...draft.seed, workspace: 'other' } }), { status: 400, error: 'bad_body', message: 'seed.workspace: an experiment keeps the workspace it was created in' });
  assert.equal(await editSections(bench.ctx(), draft, { pace: { ...draft.pace, pairs: 5 } }), 'exp-1');
  assert.equal(bench.state().benchmark.experiments[0].pace.pairs, 5);
});

test('serial runs one write at a time, in order, and a failed one does not stop the next (#478)', async () => {
  const queue = serial();
  const order: string[] = [];
  const slow = queue(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order.push('slow'); });
  const failed = queue(async () => { order.push('fail'); throw new Error('x'); });
  const fast = queue(async () => { order.push('fast'); });
  await Promise.allSettled([slow, failed, fast]);
  assert.deepEqual(order, ['slow', 'fail', 'fast']);
});
