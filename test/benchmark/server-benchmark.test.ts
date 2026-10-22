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

const REPO = { 'docs/hand.md': 'hand\n', 'fixtures/s.sql': 'sql\n' };
const seedOf = (e: Experiment, patch: Partial<Experiment['seed']>): Experiment['seed'] => ({ ...e.seed, ...patch });
const b64 = (text: string): string => Buffer.from(text).toString('base64');

test('a seed PATCH on a draft syncs seed/ in place and rehashes it; an upload the seed stops listing is removed (#459)', async (t) => {
  const draft = benchExperiment();
  const bench = await serve(t, { experiments: [draft], files: REPO });
  assert.equal((await call(bench, 'PUT', `${E}/exp-1/seed/files/notes.txt`, { content: b64('n') }))[0], 204);
  const seed = seedOf(draft, { reference: ['docs/hand.md', 'upload:notes.txt'], sample: { command: 'pnpm dev', url: 'http://localhost:5173', files: ['fixtures/s.sql'] }, scenarios: [{ id: 's1', title: 'Opens', text: 'It opens.' }] });
  assert.deepEqual(await call(bench, 'PATCH', `${E}/exp-1`, { seed }), [200, { id: 'exp-1' }]);
  const dir = bench.dir('exp-1');
  const files = await snapshot(join(dir, 'seed'));
  assert.deepEqual([files['repo/docs/hand.md'], files['repo/fixtures/s.sql'], files['upload/notes.txt'], files['scenarios.md']], [b64('hand\n'), b64('sql\n'), b64('n'), b64('## Opens\n\nIt opens.\n')]);
  assert.equal('upload/old.txt' in files, false, 'unlisted uploads pruned');
  const edited = bench.state().benchmark.experiments[0];
  assert.deepEqual(edited.seed, seed);
  assert.equal(edited.seedHash, await seedHash(seed, dir));
  await call(bench, 'PATCH', `${E}/exp-1`, { seed: { ...seed, reference: ['docs/hand.md'] } });
  assert.equal(await exists(join(dir, 'seed', 'upload', 'notes.txt')), false);
});

test('a seed PATCH on an experiment with a round answers a fork: the old experiment and folder unchanged, the fork with a new seedHash, the same plugin.hash and a copied pin (#459)', async (t) => {
  const old = benchExperiment({ status: 'done', rounds: [{ n: 1, runs: [run('aaaa1')] }] });
  const bench = await serve(t, { experiments: [old], files: REPO });
  const before = await snapshot(bench.dir('exp-1'));
  const [status, body] = await call(bench, 'PATCH', `${E}/exp-1`, { seed: seedOf(old, { reference: ['docs/hand.md'] }) });
  const forkId = (body as { id: string }).id;
  assert.equal(status, 200);
  assert.notEqual(forkId, 'exp-1');
  const [kept, fork] = bench.state().benchmark.experiments;
  assert.deepEqual(kept, old);
  assert.deepEqual(await snapshot(bench.dir('exp-1')), before);
  assert.deepEqual([fork.id, fork.name, fork.status, fork.rounds, fork.sleeps, fork.arms, fork.base], [forkId, 'Skills · 2', 'draft', [], [], old.arms, old.base]);
  assert.notEqual(fork.seedHash, old.seedHash);
  assert.equal(fork.plugin.hash, old.plugin.hash);
  const pin = (snap: Record<string, string>) => Object.fromEntries(Object.entries(snap).filter(([p]) => p.startsWith('plugin/')));
  assert.deepEqual(pin(await snapshot(bench.dir(forkId))), pin(before));
  assert.equal(await exists(join(bench.dir(forkId), 'runs')), false);
});

test('a base PATCH rehashes the tasks; the other sections land as sent; a seed naming another workspace is 400 (#459)', async (t) => {
  const e = benchExperiment();
  const bench = await serve(t, { experiments: [e] });
  const base = { ...e.base, tasks: [{ key: 'T9', title: 'Nine', body: 'b', blockedBy: [] }] };
  const pace = { ...e.pace, pairs: 5 };
  assert.deepEqual(await call(bench, 'PATCH', `${E}/exp-1`, { base, pace, blindness: { on: false, forbiddenWords: [] } }), [200, { id: 'exp-1' }]);
  const edited = bench.state().benchmark.experiments[0];
  assert.deepEqual([edited.base, edited.pace, edited.blindness.on, edited.tasksHash], [base, pace, false, tasksHash(base.tasks)]);
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1`, { seed: seedOf(e, { workspace: 'other' }) }))[0], 400);
});

test('an upload lands at seed/upload/<name>; a bad name is 400; a listed name on an experiment with rounds is 409; a repo path missing at the commit is 404 and changes nothing (#459)', async (t) => {
  const e = benchExperiment();
  const ran = benchExperiment({ id: 'exp-2', status: 'done', rounds: [{ n: 1, runs: [run('aaaa1')] }], seed: seedOf(e, { reference: ['upload:old.txt'] }) });
  const bench = await serve(t, { experiments: [e, ran], files: REPO });
  assert.equal((await call(bench, 'PUT', `${E}/exp-1/seed/files/data.sql`, { content: b64('x') }))[0], 204);
  assert.equal((await snapshot(join(bench.dir('exp-1'), 'seed', 'upload')))['data.sql'], b64('x'));
  assert.deepEqual(errorOf(await call(bench, 'PUT', `${E}/exp-1/seed/files/.hidden`, { content: b64('x') })), [400, 'bad_name']);
  assert.equal((await call(bench, 'PUT', `${E}/exp-1/seed/files/ok.txt`, { content: '***' }))[0], 400);
  assert.deepEqual(errorOf(await call(bench, 'PUT', `${E}/exp-2/seed/files/old.txt`, { content: b64('new') })), [409, 'seed_locked']);
  const before = bench.state();
  assert.deepEqual(errorOf(await call(bench, 'PATCH', `${E}/exp-1`, { seed: seedOf(e, { reference: ['docs/gone.md'] }) })), [404, 'unknown_path']);
  assert.equal(bench.state(), before);
});
test('every mutating route except name and archive answers 409 on a running or sleeping experiment (#459)', { todo: 'arm routes: Task 9' }, async (t) => {
  const running = benchExperiment({ status: 'running', rounds: [{ n: 1, runs: [run('aaaa1')] }] });
  const bench = await serve(t, { experiments: [running, benchExperiment({ id: 'exp-2', status: 'sleeping' })] });
  const refused: [string, string, unknown][] = [
    ['PATCH', `${E}/exp-1`, { base: running.base }], ['PATCH', `${E}/exp-1`, { seed: running.seed }], ['PATCH', `${E}/exp-1`, { pace: running.pace }],
    ['PATCH', `${E}/exp-1`, { isolation: running.isolation }], ['PATCH', `${E}/exp-1`, { blindness: running.blindness }], ['PATCH', `${E}/exp-1`, { evaluation: running.evaluation }],
    ['POST', `${E}/exp-1/arms`, { from: 'base' }], ['PATCH', `${E}/exp-1/arms/a1`, { name: 'x' }], ['DELETE', `${E}/exp-1/arms/a2`, undefined],
    ['POST', `${E}/exp-1/arms/a1/copy`, { what: 'tasks', to: ['a2'] }], ['PUT', `${E}/exp-1/seed/files/n.txt`, { content: b64('n') }],
    ['DELETE', `${E}/exp-1`, undefined], ['DELETE', `${E}/exp-2`, undefined],
  ];
  for (const [method, path, body] of refused) assert.equal((await call(bench, method, path, body))[0], 409, `${method} ${path}`);
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1`, { name: 'Renamed' }))[0], 200);
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1`, { archived: true }))[0], 200);
  assert.deepEqual([bench.state().benchmark.experiments[0].name, bench.state().benchmark.experiments[0].archived], ['Renamed', true]);
});
