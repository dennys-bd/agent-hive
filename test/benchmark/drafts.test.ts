import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyExperiment, draftExperiment, drafter, duplicateExperiment, editSections, isRefusal, serial } from '../../src/benchmark/drafts.js';
import { benchDeps } from './bench-server.js';
import { benchExperiment, ISOLATION, run, SHA } from './fixtures.js';

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


test('draftExperiment from a workspace writes one new draft with the given sections, arms and createdBy, in one benchmarkCreated (#478)', async (t) => {
  const bench = await benchDeps(t);
  const made = await draftExperiment(bench.ctx(), {
    workspace: 'bench', name: 'TDD', pace: { pairs: 2, runTimeoutMs: 60_000, workersPerArm: 1, cap: {} },
    arms: [{ name: 'Plain', overrides: {} }, { name: 'TDD', overrides: { items: { 'hive:new-build': 'tdd' } } }],
  }, MCP);
  assert.equal(typeof made, 'string');
  const [e] = bench.state().benchmark.experiments;
  assert.deepEqual([e.id, e.name, e.status, e.createdBy, e.pace.pairs, e.arms.map((a) => [a.letter, a.name])], [made, 'TDD', 'draft', MCP, 2, [['A', 'Plain'], ['B', 'TDD']]]);
  assert.deepEqual(bench.events.map((event) => event.type), ['benchmarkCreated']);
  assert.ok(await exists(join(bench.dir(e.id), 'plugin')));
});

test('draftExperiment from `from` copies it with the given sections; a replace keeps createdBy and createdAt and edits in one benchmarkEdited (#478)', async (t) => {
  const source = benchExperiment({ status: 'done', rounds: [{ n: 1, runs: [run('aaaa1')] }] });
  const draft = benchExperiment({ id: 'exp-2', name: 'Mine' });
  const bench = await benchDeps(t, { experiments: [source, draft] });
  const find = (id: string) => bench.state().benchmark.experiments.find((e) => e.id === id);
  const copy = await draftExperiment(bench.ctx(), { from: 'exp-1', blindness: { on: false, forbiddenWords: [] } }, MCP);
  assert.ok(typeof copy === 'string');
  assert.deepEqual([find(copy)?.createdBy, find(copy)?.rounds, find(copy)?.blindness.on, find(copy)?.arms], [MCP, [], false, source.arms]);
  assert.equal(await draftExperiment(bench.ctx(), { id: 'exp-2', name: 'Renamed', arms: [{ id: 'a2', name: 'Only', overrides: {} }], isolation: ISOLATION }, MCP), 'exp-2');
  assert.deepEqual([find('exp-2')?.name, find('exp-2')?.createdBy, find('exp-2')?.createdAt, find('exp-2')?.arms], ['Renamed', draft.createdBy, draft.createdAt, [{ id: 'a2', letter: 'A', name: 'Only', overrides: {} }]]);
  assert.deepEqual(bench.events.map((event) => event.type), ['benchmarkCreated', 'benchmarkEdited']);
});

test('draftExperiment refuses, writing no folder and dispatching nothing: zod issues, a non-draft, a draft with rounds, a perArm key naming no arm, an unknown id, from or workspace (#478)', async (t) => {
  const bench = await benchDeps(t, { experiments: [benchExperiment({ status: 'done' }), benchExperiment({ id: 'exp-2', rounds: [{ n: 1, runs: [] }] })] });
  const before = await readdir(join(bench.home, 'benchmark'));
  const answers = [
    await draftExperiment(bench.ctx(), { workspace: 'bench', pace: { pairs: 0 }, blindness: { on: 'yes' } }, MCP),
    await draftExperiment(bench.ctx(), { id: 'exp-1', name: 'x' }, MCP),
    await draftExperiment(bench.ctx(), { id: 'exp-2', name: 'x' }, MCP),
    await draftExperiment(bench.ctx(), { workspace: 'bench', isolation: { ...ISOLATION, env: { all: {}, perArm: { ghost: {} } } } }, MCP),
    await draftExperiment(bench.ctx(), { id: 'nope' }, MCP),
    await draftExperiment(bench.ctx(), { from: 'nope' }, MCP),
    await draftExperiment(bench.ctx(), { workspace: 'ghost' }, MCP),
  ];
  assert.deepEqual(answers.map((a) => (isRefusal(a) ? [a.status, a.error] : a)), [
    [400, 'bad_body'], [409, 'not_draft'], [409, 'not_draft'], [400, 'bad_body'], [404, 'unknown_experiment'], [404, 'unknown_experiment'], [404, 'unknown_workspace'],
  ]);
  const [shape, , , perArm] = answers;
  assert.ok(isRefusal(shape) && shape.message.split('\n').length >= 3);
  assert.ok(isRefusal(perArm) && perArm.message === 'isolation.env.perArm: ghost is no arm of the draft');
  assert.deepEqual(await readdir(join(bench.home, 'benchmark')), before);
  assert.deepEqual(bench.events, []);
});

test("drafter answers { id } or { refused }, one write at a time; a seed path not at the commit is refused and leaves no folder (#478)", async (t) => {
  const bench = await benchDeps(t);
  const tool = drafter({ ...bench.deps, queue: serial(), log: bench.log, live: () => ({ config: bench.config, experiments: bench.state().benchmark.experiments }) });
  const seed = { workspace: 'bench', commit: SHA, reference: ['docs/missing.md'], sample: { command: '', url: '', files: [] }, scenarios: [] };
  const [made, missing] = await Promise.all([tool.draft({ workspace: 'bench' }, MCP), tool.draft({ workspace: 'bench', seed }, MCP)]);
  assert.ok('id' in made);
  assert.deepEqual(missing, { refused: "docs/missing.md is not in the seed's commit or uploads" });
  assert.deepEqual(await readdir(join(bench.home, 'benchmark')), [made.id]);
  assert.deepEqual(await drafter({ ...bench.deps, queue: serial(), log: bench.log, live: () => undefined }).draft({ workspace: 'bench' }, MCP), { refused: 'the Hive has no config yet' });
});

test('benchmark_draft keeps the copied flow\'s structure: a base dropping a transition is refused naming base.flow; changing Spec\'s model is a draft (#536)', async (t) => {
  const bench = await benchDeps(t);
  const tool = drafter({ ...bench.deps, queue: serial(), log: bench.log, live: () => ({ config: bench.config, experiments: bench.state().benchmark.experiments }) });
  const made = await createEmptyExperiment(bench.ctx(), { workspace: 'bench', createdBy: USER });
  assert.ok(!isRefusal(made));
  const { flow } = made.base;
  const dropped = await tool.draft({ workspace: 'bench', base: { ...made.base, flow: { ...flow, transitions: flow.transitions.slice(1) } } }, MCP);
  assert.ok('refused' in dropped);
  assert.match(dropped.refused, /^base\.flow: .*structure/);
  const stages = flow.stages.map((s) => (s.name === 'Spec' ? { ...s, model: 'gpt-5-mini' } : s));
  const edited = await tool.draft({ workspace: 'bench', base: { ...made.base, flow: { ...flow, stages } } }, MCP);
  assert.ok('id' in edited);
  assert.equal(bench.state().benchmark.experiments.find((e) => e.id === edited.id)?.base.flow.stages[0].model, 'gpt-5-mini');
  const replaced = await tool.draft({ id: made.id, base: { ...made.base, flow: { ...flow, copiedAt: '2020-01-01T00:00:00.000Z' } } }, MCP);
  assert.ok('refused' in replaced);
});
