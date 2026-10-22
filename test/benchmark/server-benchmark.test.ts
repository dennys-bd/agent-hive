import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { seedHash, tasksHash, treeHash } from '../../src/benchmark/hash.js';
import { pluginTrees } from '../../src/benchmark/pin.js';
import type { Experiment } from '../../src/types.js';
import { snapshot } from '../custom-fixture.js';
import { AT, call, errorOf, serve } from './bench-server.js';
import { arm, benchExperiment, ISOLATION, run, SHA } from './fixtures.js';

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const E = '/benchmark/experiments';

test("POST empty answers a draft with arm A, the workspace's base, the defaults, the pinned plugin with its hash and the seed's commit (#459)", async (t) => {
  const bench = await serve(t);
  const [status, body] = await call(bench, 'POST', E, { kind: 'empty', workspace: 'bench' });
  const e = body as Experiment;
  assert.equal(status, 201);
  assert.match(e.id, /^x[a-z0-9]{8}$/);
  assert.deepEqual([e.status, e.name, e.createdAt, e.arms.map((a) => [a.letter, a.name, a.overrides])], ['draft', 'Experiment 1', AT, [['A', 'Arm A', {}]]]);
  assert.deepEqual(e.base.stages.spec, { agent: 'codex', model: 'gpt-5', skill: '/hive:new-spec', prompt: '/hive:new-spec {id}' });
  assert.deepEqual([e.base.stages.pr.skill, e.base.items, e.base.worktree, e.base.plugins.length, e.base.rules.deny], ['/hive:new-pr', { 'hive:new-build': 'tdd' }, { setup: 'RUN pnpm install', teardown: '' }, 2, ['Bash(gh:*)']]);
  assert.deepEqual([e.pace.pairs, e.isolation.permissionMode.all, e.blindness.on, e.evaluation.dynamic], [3, 'dontAsk', true, true]);
  const dir = bench.dir(e.id);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.ok(await exists(join(dir, 'plugin', 'source', 'skills', 'new-build', 'SKILL.md')));
  assert.ok(await exists(join(dir, 'plugin', 'custom', 'hive', 'new-build', 'tdd', 'version.json')));
  assert.deepEqual(e.plugin, { version: '0.1.0', hash: await treeHash(pluginTrees(dir)) });
  assert.equal(e.seed.commit, SHA);
  assert.ok(bench.calls.some((c) => c.join(' ') === `-C ${bench.repo} rev-parse --verify origin/main^{commit}`));
  assert.deepEqual([e.seedHash, e.tasksHash], [await seedHash(e.seed, dir), tasksHash([])]);
  assert.deepEqual(bench.state().benchmark.experiments, [e]);
  assert.equal(((await call(bench, 'POST', E, { kind: 'empty', workspace: 'bench' }))[1] as Experiment).name, 'Experiment 2');
});

test('POST duplicate copies arms, tasks and every section, no rounds, keeps plugin.hash and seedHash, and copies the pin and seed/ only (#459)', async (t) => {
  const tasks = [{ key: 'T1', title: 'One', body: '', blockedBy: [] }];
  const source = benchExperiment({ status: 'done', arms: [arm('a1', 'A', { tasks }), arm('a2', 'B')], isolation: { ...ISOLATION, network: { all: [], perArm: { a2: ['x.test'] } } }, rounds: [{ n: 1, runs: [run('aaaa1')] }] });
  const bench = await serve(t, { experiments: [source] });
  const [status, body] = await call(bench, 'POST', E, { kind: 'duplicate', of: 'exp-1' });
  const copy = body as Experiment;
  assert.equal(status, 201);
  assert.deepEqual([copy.name, copy.status, copy.rounds, copy.arms, copy.base, copy.pace, copy.isolation, copy.blindness, copy.evaluation, copy.seed], ['Skills · copy', 'draft', [], source.arms, source.base, source.pace, source.isolation, source.blindness, source.evaluation, source.seed]);
  assert.deepEqual([copy.plugin, copy.seedHash, copy.tasksHash], [source.plugin, source.seedHash, source.tasksHash]);
  assert.deepEqual(Object.keys(await snapshot(bench.dir(copy.id))).sort(), Object.keys(await snapshot(bench.dir('exp-1'))).filter((p) => !p.startsWith('runs/')).sort());
});

test('DELETE removes the folder and the experiment; archived true keeps the folder and false clears it (#459)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment(), benchExperiment({ id: 'exp-2' })] });
  assert.deepEqual(await call(bench, 'PATCH', `${E}/exp-2`, { archived: true }), [200, { id: 'exp-2' }]);
  assert.equal(bench.state().benchmark.experiments[1].archived, true);
  assert.ok(await exists(bench.dir('exp-2')));
  await call(bench, 'PATCH', `${E}/exp-2`, { archived: false });
  assert.equal('archived' in bench.state().benchmark.experiments[1], false);
  assert.equal((await call(bench, 'DELETE', `${E}/exp-1`))[0], 204);
  assert.equal(await exists(bench.dir('exp-1')), false);
  assert.deepEqual(bench.state().benchmark.experiments.map((e) => e.id), ['exp-2']);
});

test('a bad body answers 400 bad_body; an unknown experiment or workspace answers 404; nothing is written (#459)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment()] });
  const answers = [
    await call(bench, 'POST', E, { kind: 'nope' }), await call(bench, 'POST', E, { kind: 'empty', workspace: 'bench', extra: 1 }),
    await call(bench, 'PATCH', `${E}/exp-1`, { status: 'done' }), await call(bench, 'PATCH', `${E}/exp-1`, { name: '' }),
    await call(bench, 'POST', E, { kind: 'empty', workspace: 'ghost' }), await call(bench, 'POST', E, { kind: 'duplicate', of: 'nope' }),
    await call(bench, 'PATCH', `${E}/nope`, { name: 'x' }), await call(bench, 'DELETE', `${E}/nope`),
  ];
  assert.deepEqual(answers.map(errorOf), [
    [400, 'bad_body'], [400, 'bad_body'], [400, 'bad_body'], [400, 'bad_body'],
    [404, 'unknown_workspace'], [404, 'unknown_experiment'], [404, 'unknown_experiment'], [404, 'unknown_experiment'],
  ]);
  assert.ok(Object.keys(await snapshot(join(bench.home, 'benchmark'))).every((p) => p.startsWith('exp-1/')));
});
