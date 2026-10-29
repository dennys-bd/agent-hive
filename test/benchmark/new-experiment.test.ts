import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseSnapshot, BLIND_WORDS, DEFAULT_PACE, defaultIsolation, duplicateOf, emptyExperiment, emptySeed, forkName, forkOf, newId } from '../../src/benchmark/new-experiment.js';
import { SANDBOX_DOMAINS } from '../../src/benchmark/sandbox.js';
import { WORKER_ALLOW, WORKER_DENY } from '../../src/benchmark/worker-rules.js';
import type { CatalogueItem } from '../../src/types.js';
import { copyFlow } from '../../src/benchmark/flow-copy.js';
import { BENCH_STAGES, benchConfig, benchExperiment, NOW, run } from './fixtures.js';

const version = (name: string, workspaces: string[]) => ({ name, from: 'original', workspaces, unknownWorkspaces: [], updateAvailable: false, editedAt: '' });
const item = (id: string, versions: ReturnType<typeof version>[]): CatalogueItem =>
  ({ id, origin: id.split(':')[0], kind: 'skill', name: id.split(':')[1], description: '', userCreated: false, state: 'customized', versions, onOriginal: [], files: [], usage: [] });

test('baseSnapshot: the copied flow, plugins, rules, items, worktree and no tasks (#459, #536)', () => {
  const config = benchConfig('/work/bench');
  const catalogue = [item('hive:new-build', [version('mine', ['other']), version('tdd', ['bench'])]), item('hive:architect', [version('mine', ['other'])])];
  const copy = copyFlow(config, 'bench', NOW);
  assert.ok('flow' in copy);
  assert.deepEqual(baseSnapshot(config, config.comb.workspaces[0], catalogue, NOW), {
    flow: copy.flow,
    plugins: ['/plugins/extra', '/plugins/two'],
    rules: { allow: ['Read', 'Bash(npm run test:coverage *)'], deny: ['Bash(gh:*)'] },
    tasks: [], items: { 'hive:new-build': 'tdd' }, worktree: { setup: 'RUN pnpm install', teardown: '' },
  });
});

test('baseSnapshot refuses a flow with a wait for CI, naming the stage (#536)', () => {
  const config = benchConfig('/work/bench');
  const ci = { ...config, comb: { ...config.comb, stages: [...BENCH_STAGES, { name: 'CI', from: {}, action: 'waitForCi' as const, ciChecks: 'all' as const, rerunOnce: false }] } };
  const answer = baseSnapshot(ci, config.comb.workspaces[0], [], NOW);
  assert.ok('refused' in answer);
  assert.match(answer.refused, /CI waits for CI/);
});

test("emptyExperiment is a draft with arm A and the screens' defaults (#459)", () => {
  const e = emptyExperiment({ id: 'xabc12345', armId: 'xarm00001', name: 'Experiment 1', createdAt: 'T', seed: emptySeed('bench', 'c'.repeat(40)), base: benchExperiment().base, judge: 'codex', plugin: { version: '0.1.0', hash: 'p' }, seedHash: 's', tasksHash: 't' });
  assert.deepEqual([e.status, e.workspace, e.arms, e.rounds, e.sleeps], ['draft', 'bench', [{ id: 'xarm00001', letter: 'A', name: 'Arm A', overrides: {} }], [], []]);
  assert.deepEqual(e.pace, { pairs: 3, until: '07:00', runTimeoutMs: 72_000_000, workersPerArm: 3, cap: {} });
  assert.deepEqual(e.pace, DEFAULT_PACE);
  assert.deepEqual([e.isolation.network.all, e.isolation.allowedTools.all, e.isolation.deniedTools.all], [[...SANDBOX_DOMAINS], [...WORKER_ALLOW], [...WORKER_DENY]]);
  assert.deepEqual([e.isolation.permissionMode.all, e.isolation.limits.all, e.isolation.env.all], ['dontAsk', { turns: 200, ms: 7_200_000 }, { CI: '1' }]);
  assert.deepEqual(e.isolation, defaultIsolation());
  assert.deepEqual(e.blindness, { on: true, forbiddenWords: [...BLIND_WORDS] });
  assert.deepEqual(e.evaluation, { collectors: [], dynamic: true, tester: { agent: 'claude', model: 'sonnet' }, scenarioWalks: 1, judge: { agent: 'codex' }, rubric: '' });
});

test('duplicateOf and forkOf keep arms, base and every section, drop rounds, sleeps, archived and stopAfterRound; the fork takes the new seed (#459)', () => {
  const source = benchExperiment({ status: 'done', archived: true, stopAfterRound: true, rounds: [{ n: 1, runs: [run('aaaa1')] }], sleeps: [{ round: 1, at: 'T', reason: 'x' }] });
  const copy = duplicateOf(source, { id: 'xcopy0001', name: 'Skills · copy', createdAt: 'T2' });
  const { id: _i, name: _n, createdAt: _c, status: _s, rounds: _r, sleeps: _l, archived: _a, stopAfterRound: _x, ...kept } = source;
  assert.deepEqual(copy, { ...kept, id: 'xcopy0001', name: 'Skills · copy', createdAt: 'T2', status: 'draft', createdBy: { kind: 'user' }, rounds: [], sleeps: [] });
  const seed = { ...source.seed, reference: ['a.md'] };
  const fork = forkOf(source, { id: 'xfork0001', name: 'Skills · 2', createdAt: 'T2', seed, seedHash: 'new' });
  assert.deepEqual([fork.seed, fork.seedHash, fork.plugin, fork.arms], [seed, 'new', source.plugin, source.arms]);
});

test('newId skips a taken id; forkName takes the next free number (#459)', () => {
  const draws = ['aaaaaaaa', 'bbbbbbbb'];
  assert.equal(newId(['xaaaaaaaa'], () => draws.shift() ?? ''), 'xbbbbbbbb');
  assert.equal(forkName('Skills', ['Skills', 'Skills · 2', 'Skills · 3']), 'Skills · 4');
});
