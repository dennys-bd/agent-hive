import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBenchmark } from '../../src/benchmark-guards.js';
import { initialState } from '../../src/orchestrator.js';
import { loadState } from '../../src/state-store.js';
import { tempDir } from '../temp-dir.js';
import type { ArmOverrides, ArmSetup } from '../../src/types.js';
import { arm, experiment, run, SETUP } from './fixtures.js';

const AT = '2026-10-21T11:00:00.000Z';
const saved = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const ROOT = '/hive'; // the fixtures' fake Hive home
const load = (raw: unknown) => loadBenchmark(raw, ROOT);
const ids = (raw: unknown): string[] => load(raw).experiments.map((e) => e.id);
// One experiment whose round 1 holds a run with `patch` over it, then a good run
const withRun = (patch: Record<string, unknown>): unknown =>
  saved({ experiments: [{ ...experiment(), rounds: [{ n: 1, runs: [{ ...run('cccc1'), ...patch }, run('keep1')] }] }] });

test('a state.json without benchmark, or with a malformed one, loads no experiment (#458)', () => {
  for (const raw of [undefined, null, 'x', [], {}, { experiments: 'x' }]) assert.deepEqual(load(raw), { experiments: [] }, String(JSON.stringify(raw)));
});

test('a running experiment boots done: its queued, running and waiting runs interrupted with no endedAt, its ended runs as saved, stopAfterRound gone (#458)', () => {
  const runs = [
    run('aaaa1', { status: 'queued' }), run('aaaa2', { status: 'running' }), run('aaaa3', { status: 'waiting', endedAt: AT }),
    run('aaaa4', { status: 'done', endedAt: AT }), run('aaaa5', { status: 'timeout', endedAt: AT }),
  ];
  const [loaded] = load(saved({ experiments: [experiment({ status: 'running', stopAfterRound: true, rounds: [{ n: 1, startedAt: AT, runs }] })] })).experiments;
  assert.equal(loaded.status, 'done');
  assert.equal('stopAfterRound' in loaded, false);
  assert.deepEqual(loaded.rounds[0].runs.map((r) => r.status), ['interrupted', 'interrupted', 'interrupted', 'done', 'timeout']);
  assert.deepEqual(loaded.rounds[0].runs.map((r) => 'endedAt' in r), [false, false, false, true, true]);
});

test('a sleeping experiment loads as saved: its sleeping runs, its sleeps and its stopAfterRound (#458)', () => {
  const sleeping = experiment({ status: 'sleeping', stopAfterRound: true, rounds: [{ n: 1, startedAt: AT, runs: [run('bbbb1', { status: 'sleeping' })] }], sleeps: [{ round: 1, at: AT, reason: 'night' }] });
  assert.deepEqual(load(saved({ experiments: [sleeping] })).experiments, [sleeping]);
});

test('an experiment is dropped whole on a bad id, status, text field, seed commit, config object or list; duplicate ids keep the first (#458)', () => {
  const good = experiment({ id: 'keep' });
  const bad: Record<string, unknown>[] = [
    { id: 'Bad Id' }, { id: '-lead' }, { status: 'paused' }, { name: 1 }, { createdAt: null }, { workspace: ['hive'] }, { seedHash: 1 }, { tasksHash: null },
    { seed: { ...good.seed, commit: 'HEAD' } }, { base: null }, { pace: [] }, { isolation: 'x' }, { blindness: 1 }, { evaluation: undefined },
    { createdBy: 'user' }, { plugin: null }, { arms: {} }, { rounds: 'x' }, { sleeps: null },
  ];
  for (const patch of bad) assert.deepEqual(ids(saved({ experiments: [{ ...experiment({ id: 'drop' }), ...patch }, good] })), ['keep'], JSON.stringify(patch));
  assert.deepEqual(load(saved({ experiments: [good, { ...good, name: 'second' }] })).experiments.map((e) => e.name), ['Skills']);
});

test('a run is dropped alone on a bad token, status, branch, home or shape; its round and experiment stay (#458)', () => {
  const bad: Record<string, unknown>[] = [
    { token: 'ab1' }, { token: 'UPPER1' }, { status: 'paused' }, { branch: '-x' }, { branch: 'a..b' },
    { home: 'benchmark/exp-1/runs/cccc1' }, { home: '/hive/../benchmark/exp-1/runs/cccc1' }, { home: '/hive/benchmark/other/runs/cccc1' }, { home: '/hive/benchmark/exp-1/runs/dddd1' }, { home: '/other/benchmark/exp-1/runs/cccc1' }, { home: '/hive/benchmark/exp-1/runs/cccc1/' }, { branch: 'main' }, { branch: 'neutral/dddd1' },
    { armId: 1 }, { sleptMs: 'x' }, { total: null }, { interventions: null },
  ];
  for (const patch of bad) {
    const [loaded] = load(withRun(patch)).experiments;
    assert.deepEqual(loaded.rounds.map((r) => r.runs.map((x) => x.token)), [['keep1']], JSON.stringify(patch));
  }
});

test('a round whose n is not a positive integer, or with no runs list, is dropped with its runs; an arm without a string id or letter is dropped (#458)', () => {
  const rounds = [{ n: 0, runs: [run('eeee1')] }, { n: 1.5, runs: [run('eeee2')] }, { n: '2', runs: [] }, { n: 3, runs: 'x' }, { n: 4, runs: [run('eeee4')] }];
  const [loaded] = load(saved({ experiments: [{ ...experiment(), rounds }] })).experiments;
  assert.deepEqual(loaded.rounds.map((r) => [r.n, r.runs.map((x) => x.token)]), [[4, ['eeee4']]]);
  const arms = [arm('a1', 'A'), { id: 2, letter: 'B', name: 'x', overrides: {} }, { id: 'a3', name: 'x', overrides: {} }, arm('__proto__', 'C'), arm('a1', 'D')];
  assert.deepEqual(load(saved({ experiments: [{ ...experiment(), arms }] })).experiments[0].arms.map((a) => a.id), ['a1']);
});

test('loadState reads state.benchmark through the guard, and a file without it as no experiment (#458)', async (t) => {
  const dir = await tempDir(t, 'bench-');
  const running = experiment({ status: 'running', rounds: [{ n: 1, runs: [run('ffff1', { home: join(dir, 'benchmark', 'exp-1', 'runs', 'ffff1') })] }] });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), benchmark: { experiments: [running] } }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.benchmark.experiments.map((e) => [e.status, e.rounds[0].runs[0].status]), [['done', 'interrupted']]);
  const { benchmark: _gone, ...before } = initialState(0);
  await writeFile(join(dir, 'state.json'), JSON.stringify(before));
  assert.deepEqual((await loadState(dir)).benchmark, { experiments: [] });
});

test('a token saved twice keeps its first run only, so two runs never share a home and a branch (#458)', () => {
  const [loaded] = load(saved({ experiments: [{ ...experiment(), rounds: [{ n: 1, runs: [run('gggg1')] }, { n: 2, runs: [run('gggg1', { round: 2 }), run('gggg2', { round: 2 })] }] }] })).experiments;
  assert.deepEqual(loaded.rounds.map((r) => r.runs.map((x) => x.token)), [['gggg1'], ['gggg2']]);
});

test('an experiment saved before #536, its base holding the four stages, loads as none (#536)', () => {
  const { flow: _flow, ...rest } = SETUP;
  const old = { ...rest, stages: { spec: { agent: 'claude', skill: '/s', prompt: 'p' }, plan: {}, build: {}, pr: {} } };
  assert.deepEqual(ids(saved({ experiments: [experiment({ base: old as unknown as ArmSetup })] })), []);
});

test('an experiment whose base has a malformed flow, no items map or no worktree setup does not load (#471, #536)', () => {
  const stage = SETUP.flow.stages[0];
  const bases = [
    { ...SETUP, flow: { ...SETUP.flow, stages: 'x' } }, { ...SETUP, flow: { ...SETUP.flow, stages: [] } }, { ...SETUP, flow: { ...SETUP.flow, stages: [{ ...stage, from: {} }] } },
    { ...SETUP, flow: { ...SETUP.flow, transitions: [{ from: 'Spec', to: 'Plan' }] } }, { ...SETUP, flow: { ...SETUP.flow, commands: [{ name: 'test' }] } },
    { ...SETUP, flow: { ...SETUP.flow, copiedAt: 1 } }, { ...SETUP, items: undefined }, { ...SETUP, worktree: { setup: 'x' } },
  ];
  for (const base of bases) assert.deepEqual(ids(saved({ experiments: [experiment({ base: base as ArmSetup })] })), [], JSON.stringify(base));
  assert.deepEqual(ids(saved({ experiments: [experiment()] })), ['exp-1']);
});

test('an items entry must name an item id of two segments and a version name: original, a path or a bad id drops the experiment (#471)', () => {
  const malformed: Record<string, string>[] = [{ 'hive:new-spec': 'original' }, { 'hive:new-spec': '../x' }, { 'new-spec': 'terse' }, { 'a:b:c': 'terse' }];
  for (const items of malformed) {
    assert.deepEqual(ids(saved({ experiments: [experiment({ base: { ...SETUP, items } })] })), [], JSON.stringify(items));
  }
  assert.deepEqual(ids(saved({ experiments: [experiment({ base: { ...SETUP, items: { 'hive:new-spec': 'terse' } } })] })), ['exp-1']);
});

test('an arm whose overrides carry a malformed items, worktree or stages is dropped; one that omits them loads (#471)', () => {
  const bad = arm('a3', 'C', { items: { 'hive:x': 'original' } });
  const [loaded] = load(saved({ experiments: [experiment({ arms: [arm('a1', 'A'), bad, arm('a2', 'B', { worktree: { setup: '', teardown: '' } })] })] })).experiments;
  assert.deepEqual(loaded.arms.map((a) => a.id), ['a1', 'a2']);
});

test('an experiment whose evaluation has no tester object or no integer scenarioWalks of at least 1 is dropped whole (#474)', () => {
  const good = experiment({ id: 'keep' });
  const bad: Record<string, unknown>[] = [
    { tester: undefined }, { tester: 'claude' }, { tester: null }, { tester: {} }, { tester: { agent: 'gemini' } }, { tester: { agent: 42 } },
    { scenarioWalks: undefined }, { scenarioWalks: 0 }, { scenarioWalks: 1.5 }, { scenarioWalks: '2' },
  ];
  for (const patch of bad) {
    const drop = { ...experiment({ id: 'drop' }), evaluation: { ...good.evaluation, ...patch } };
    assert.deepEqual(ids(saved({ experiments: [drop, good] })), ['keep'], JSON.stringify(patch));
  }
});

test('an arm whose stages hold some stages by any name and some fields, or a null model, loads; a bad field or an override holding flow drops it (#462, #536)', () => {
  const partial = arm('a2', 'B', { stages: { Build: { agent: 'codex', model: null }, Review: { judge: { agent: 'claude' }, threshold: 8 }, Checks: { commands: ['test'] } } });
  const notObject = arm('a3', 'C', { stages: { Build: 'codex' } } as unknown as ArmOverrides);
  const badAgent = arm('a4', 'D', { stages: { Build: { agent: 'gemini' } } } as unknown as ArmOverrides);
  const badModel = arm('a5', 'E', { stages: { Build: { model: 5 } } } as unknown as ArmOverrides);
  const unknownField = arm('a6', 'F', { stages: { Build: { from: {} } } } as unknown as ArmOverrides);
  const withFlow = arm('a7', 'G', { flow: SETUP.flow } as unknown as ArmOverrides);
  const nullAgent = arm('a8', 'H', { stages: { Build: { agent: null } } } as unknown as ArmOverrides);
  const [loaded] = load(saved({ experiments: [experiment({ arms: [arm('a1', 'A'), partial, notObject, badAgent, badModel, unknownField, withFlow, nullAgent] })] })).experiments;
  assert.deepEqual(loaded.arms.map((a) => a.id), ['a1', 'a2']);
});

test('a loaded experiment keeps an mcp createdBy and drops an arm whose id is no id (#478)', () => {
  const e = experiment({ createdBy: { kind: 'mcp', agent: 'claude', model: 'opus' }, arms: [arm('a1', 'A'), arm('../x', 'B')] });
  const [loaded] = load(saved({ experiments: [e] })).experiments;
  assert.deepEqual([loaded.createdBy, loaded.arms.map((a) => a.id)], [{ kind: 'mcp', agent: 'claude', model: 'opus' }, ['a1']]);
});
