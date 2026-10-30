import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { seedHash, tasksHash, treeHash } from '../../src/benchmark/hash.js';
import { pluginTrees } from '../../src/benchmark/pin.js';
import type { Experiment } from '../../src/types.js';
import { put, snapshot } from '../custom-fixture.js';
import { AT, call, errorOf, serve } from './bench-server.js';
import { arm, BENCH_STAGES, benchExperiment, ISOLATION, run, SHA } from './fixtures.js';

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const E = '/benchmark/experiments';

test("POST empty answers a draft with arm A, the workspace's base, the defaults, the pinned plugin with its hash and the seed's commit (#459)", async (t) => {
  const bench = await serve(t);
  const [status, body] = await call(bench, 'POST', E, { kind: 'empty', workspace: 'bench' });
  const e = body as Experiment;
  assert.equal(status, 201);
  assert.match(e.id, /^x[a-z0-9]{8}$/);
  assert.deepEqual([e.status, e.name, e.createdAt, e.arms.map((a) => [a.letter, a.name, a.overrides])], ['draft', 'Experiment 1', AT, [['A', 'Arm A', {}]]]);
  assert.deepEqual(e.base.flow.stages.map((s) => s.name), ['Spec', 'Plan', 'Build', 'Checks', 'Review', 'Done']);
  assert.deepEqual(e.base.flow.commands, [{ name: 'test', line: 'pnpm test' }, { name: 'lint', line: 'pnpm lint' }]);
  assert.deepEqual([e.base.items, e.base.worktree, e.base.plugins.length, e.base.rules.deny], [{ 'hive:new-build': 'tdd' }, { setup: 'RUN pnpm install', teardown: '' }, 2, ['Bash(gh:*)']]);
  assert.deepEqual([e.pace.pairs, e.isolation.permissionMode.all, e.blindness.on, e.evaluation.dynamic], [3, 'dontAsk', true, true]);
  assert.deepEqual(e.evaluation.tester, { agent: 'claude', model: 'sonnet' });
  assert.equal(e.evaluation.scenarioWalks, 1);
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

test('POST empty from a flow with a wait for CI answers 422 with the stage that blocks it, and writes nothing (#536)', async (t) => {
  const bench = await serve(t, { stages: [...BENCH_STAGES, { name: 'CI', from: {}, action: 'waitForCi', ciChecks: 'all', rerunOnce: false }] });
  const answer = await call(bench, 'POST', E, { kind: 'empty', workspace: 'bench' });
  assert.deepEqual(errorOf(answer), [422, 'flow_refused']);
  assert.match((answer[1] as { message: string }).message, /CI waits for CI/);
  assert.deepEqual(bench.state().benchmark.experiments, []);
  assert.deepEqual(await readdir(join(bench.home, 'benchmark')).catch(() => []), []);
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

test('a PATCH with name and a forking seed names the fork and leaves the old experiment untouched (#459)', async (t) => {
  const old = benchExperiment({ status: 'done', rounds: [{ n: 1, runs: [run('aaaa1')] }] });
  const bench = await serve(t, { experiments: [old], files: REPO });
  const [, body] = await call(bench, 'PATCH', `${E}/exp-1`, { name: 'Renamed', seed: seedOf(old, { reference: ['docs/hand.md'] }) });
  const [kept, fork] = bench.state().benchmark.experiments;
  assert.equal(fork.id, (body as { id: string }).id);
  assert.deepEqual([kept.name, fork.name], [old.name, 'Renamed']);
});

test('a PATCH whose seed equals the current one is no seed edit: no fork, the other sections land (#459)', async (t) => {
  const old = benchExperiment({ status: 'done', rounds: [{ n: 1, runs: [run('aaaa1')] }] });
  const bench = await serve(t, { experiments: [old], files: REPO });
  const pace = { ...old.pace, pairs: 7 };
  assert.deepEqual(await call(bench, 'PATCH', `${E}/exp-1`, { seed: structuredClone(old.seed), pace }), [200, { id: 'exp-1' }]);
  const { experiments } = bench.state().benchmark;
  assert.deepEqual([experiments.length, experiments[0].pace.pairs], [1, 7]);
});

test('a duplicate whose source folder cannot be copied answers 500 and leaves no folder behind (#459)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment()] });
  await rm(join(bench.dir('exp-1'), 'seed'), { recursive: true });
  assert.equal((await call(bench, 'POST', E, { kind: 'duplicate', of: 'exp-1' }))[0], 500);
  assert.deepEqual(await readdir(join(bench.home, 'benchmark')), ['exp-1']);
});

test('PATCH base may change a stage\'s agent and prompt, never the flow\'s structure, and writes nothing on a refusal (#536)', async (t) => {
  const bench = await serve(t);
  const [, created] = await call(bench, 'POST', E, { kind: 'empty', workspace: 'bench' });
  const e = created as Experiment;
  const stages = e.base.flow.stages.map((s) => (s.name === 'Spec' ? { ...s, agent: 'claude' as const, model: 'opus', prompt: '/x {id}' } : s));
  assert.deepEqual(await call(bench, 'PATCH', `${E}/${e.id}`, { base: { ...e.base, flow: { ...e.base.flow, stages } } }), [200, { id: e.id }]);
  const renamed = stages.map((s) => (s.name === 'Spec' ? { ...s, name: 'Other' } : s));
  const answer = await call(bench, 'PATCH', `${E}/${e.id}`, { base: { ...e.base, flow: { ...e.base.flow, stages: renamed } } });
  assert.deepEqual(errorOf(answer), [400, 'bad_body']);
  assert.match((answer[1] as { message: string }).message, /structure|copied flow/);
  const missing = stages.map((s) => (s.name === 'Checks' ? { ...s, commands: ['deploy'] } : s));
  assert.match(((await call(bench, 'PATCH', `${E}/${e.id}`, { base: { ...e.base, flow: { ...e.base.flow, stages: missing } } }))[1] as { message: string }).message, /no line for command deploy/);
  assert.deepEqual(bench.state().benchmark.experiments[0].base.flow.stages[0].prompt, '/x {id}');
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
test('every mutating route except name and archive answers 409 on a running or sleeping experiment (#459)', async (t) => {
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

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

test('each arm route changes the state as named: add from base or from an arm, rename, override, reset, copy, remove (#459)', async (t) => {
  const tasks = [{ key: 'T1', title: 'One', body: '', blockedBy: [] }];
  const bench = await serve(t, { experiments: [benchExperiment({ arms: [arm('a1', 'A', { plugins: ['p'], tasks }), arm('a2', 'B')] })] });
  const arms = () => bench.state().benchmark.experiments[0].arms;
  const [created, fromBase] = await call(bench, 'POST', `${E}/exp-1/arms`, { from: 'base' });
  assert.deepEqual([created, fromBase], [201, { ...(fromBase as object), letter: 'C', name: 'Arm C', overrides: {} }]);
  const fromArm = (await call(bench, 'POST', `${E}/exp-1/arms`, { from: 'a1' }))[1] as { id: string; overrides: object };
  assert.deepEqual(fromArm.overrides, { plugins: ['p'], tasks });
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1/arms/a2`, { name: 'skills off', overrides: { plugins: ['q'] } }))[0], 204);
  assert.deepEqual(arms()[1], { id: 'a2', letter: 'B', name: 'skills off', overrides: { plugins: ['q'] } });
  assert.equal((await call(bench, 'POST', `${E}/exp-1/arms/a1/copy`, { what: 'tasks', to: ['a2'] }))[0], 204);
  assert.deepEqual(arms()[1].overrides, { plugins: ['q'], tasks });
  for (const a of arms()) await call(bench, 'PATCH', `${E}/exp-1/arms/${a.id}`, { overrides: {} }); // reset all to base
  assert.ok(arms().every((a) => Object.keys(a.overrides).length === 0));
  assert.equal((await call(bench, 'DELETE', `${E}/exp-1/arms/${fromArm.id}`))[0], 204);
  assert.deepEqual(arms().map((a) => a.letter), ['A', 'B', 'C']);
});

test('each arm route answers 404 for an unknown experiment or arm (#459)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment()] });
  const cases: [string, string, unknown][] = [
    ['POST', `${E}/nope/arms`, { from: 'base' }], ['POST', `${E}/exp-1/arms`, { from: 'nope' }],
    ['PATCH', `${E}/nope/arms/a1`, { name: 'x' }], ['PATCH', `${E}/exp-1/arms/nope`, { name: 'x' }],
    ['DELETE', `${E}/nope/arms/a1`, undefined], ['DELETE', `${E}/exp-1/arms/nope`, undefined],
    ['POST', `${E}/nope/arms/a1/copy`, { what: 'tasks', to: ['a2'] }], ['POST', `${E}/exp-1/arms/nope/copy`, { what: 'tasks', to: ['a2'] }],
    ['POST', `${E}/exp-1/arms/a1/copy`, { what: 'tasks', to: ['nope'] }],
  ];
  for (const [method, path, body] of cases) assert.equal((await call(bench, method, path, body))[0], 404, `${method} ${path} ${JSON.stringify(body)}`);
});

test('removing the last arm and a 27th arm answer 409 and change nothing (#459)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment({ arms: [arm('a1', 'A')] }), benchExperiment({ id: 'exp-2', arms: LETTERS.map((l, i) => arm(`a${i}`, l)) })] });
  const before = bench.state();
  assert.deepEqual(errorOf(await call(bench, 'DELETE', `${E}/exp-1/arms/a1`)), [409, 'last_arm']);
  assert.deepEqual(errorOf(await call(bench, 'POST', `${E}/exp-2/arms`, { from: 'base' })), [409, 'no_letter']);
  assert.equal(bench.state(), before);
});

test('registerBenchmarkRoutes mounts the PR routes: a preview of an unknown experiment answers the PR route\'s own 404 (#477)', async (t) => {
  const bench = await serve(t);
  assert.deepEqual(errorOf(await call(bench, 'GET', `${E}/nope/runs/aaaa1/pr`)), [404, 'no such experiment']);
});

test('a PATCH of the evaluation refuses scenarioWalks 0 and saves a tester row with 3 walks (#474)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment()] });
  const evaluation = benchExperiment().evaluation;
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1`, { evaluation: { ...evaluation, scenarioWalks: 0 } }))[0], 400);
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1`, { evaluation: { ...evaluation, tester: { agent: 'claude' }, scenarioWalks: 3 } }))[0], 200);
  assert.deepEqual([bench.state().benchmark.experiments[0].evaluation.tester, bench.state().benchmark.experiments[0].evaluation.scenarioWalks], [{ agent: 'claude' }, 3]);
});

test("registerBenchmarkRoutes mounts the control routes: run on an unknown experiment answers the control route's own 404 (#472)", async (t) => {
  const bench = await serve(t);
  assert.deepEqual(errorOf(await call(bench, 'POST', `${E}/nope/run`, {})), [404, 'unknown_experiment']);
});

test('an arm PATCH accepts a partial stage by name with a null model and refuses an unknown field or agent (#462, #536)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment()] });
  const overrides = { stages: { Build: { agent: 'codex', model: null } } };
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1/arms/a1`, { overrides }))[0], 204);
  assert.deepEqual(bench.state().benchmark.experiments[0].arms[0].overrides, overrides);
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1/arms/a1`, { overrides: { stages: { Build: { from: {} } } } }))[0], 400);
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1/arms/a1`, { overrides: { stages: { Build: { agent: 'gemini' } } } }))[0], 400);
  assert.equal((await call(bench, 'PATCH', `${E}/exp-1/arms/a1`, { overrides: { stages: { Build: { model: '' } } } }))[0], 400);
});

test("GET items lists the pin's items and versions, not the current store's; 404 for an unknown experiment (#462)", async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment()] });
  const pinned = join(bench.dir('exp-1'), 'plugin', 'custom', 'hive', 'new-build');
  await rm(join(pinned, 'tdd'), { recursive: true }); // the current store keeps tdd: the answer must not
  await put(join(pinned, 'terse'), { 'version.json': JSON.stringify({ name: 'terse', from: 'original', workspaces: ['bench'] }), 'files/SKILL.md': 'terse\n' });
  assert.deepEqual(await call(bench, 'GET', `${E}/exp-1/items`), [200, { items: [{ id: 'hive:new-build', name: 'new-build', kind: 'skill', versions: ['terse'] }] }]);
  assert.deepEqual(errorOf(await call(bench, 'GET', `${E}/nope/items`)), [404, 'unknown_experiment']);
});

test('PATCH an arm refuses an override for a stage the flow lacks or a field that does not fit the stage, naming both (#536)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment({ arms: [arm('a1', 'A')] })] });
  const patch = (stages: object) => call(bench, 'PATCH', `${E}/exp-1/arms/a1`, { overrides: { stages } });
  const unknown = await patch({ Nope: { agent: 'claude' } });
  assert.deepEqual(errorOf(unknown), [400, 'bad_body']);
  assert.match(JSON.stringify(unknown[1]), /arm A.*Nope/);
  assert.deepEqual(errorOf(await patch({ Spec: { threshold: 3 } })), [400, 'bad_body']);
  assert.deepEqual(errorOf(await patch({ Spec: { commands: ['x'] } })), [400, 'bad_body']);
  assert.deepEqual(bench.state().benchmark.experiments[0].arms[0].overrides, {});
  assert.equal((await patch({ Spec: { model: 'opus' } }))[0], 204);
});
