import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeArm, resolveRow, runConfig, runStages, runState, watchTasks } from '../../src/benchmark/arm-config.js';
import { copyFlow } from '../../src/benchmark/flow-copy.js';
import { DONE_STAGE } from '../../src/benchmark/watcher.js';
import { parseConfig } from '../../src/config.js';
import type { ArmOverrides, BenchFlow } from '../../src/types.js';
import { arm, benchComb, experiment, ISOLATION, mainConfig, NOW, SETUP } from './fixtures.js';

const PATHS = { clone: '/hive/benchmark/exp-1/clone', home: '/hive/benchmark/exp-1/runs/abcd1234', rules: { home: '/hive/benchmark/exp-1/runs/abcd1234', homes: ['/hive'], denied: [] } };

test('mergeArm takes an override key whole; resolveRow takes the arm\'s value, else the row\'s, never a prototype key (#471)', () => {
  assert.deepEqual(mergeArm(SETUP, { items: { 'hive:new-spec': 'terse' } }), { ...SETUP, items: { 'hive:new-spec': 'terse' } });
  assert.equal(mergeArm(SETUP, {}).worktree, SETUP.worktree);
  const row = { all: 'a', perArm: { a2: 'b' } };
  assert.deepEqual([resolveRow(row, 'a2'), resolveRow(row, 'a1'), resolveRow(row, 'constructor')], ['b', 'a', 'a']);
});

const copied = (): BenchFlow => { const r = copyFlow(benchComb(), 'bench', NOW); assert.ok('flow' in r); return r.flow; };

test('runStages keeps the copied stages and transitions with their verdicts and tries; end reaches Delivered (#536)', () => {
  const { stages, transitions } = runStages(copied(), 'claude');
  assert.deepEqual(stages.map((s) => s.name), ['Spec', 'Plan', 'Build', 'Checks', 'Review', 'Done', DONE_STAGE]);
  assert.ok(stages.every((s) => Object.keys(s.from).length === 0));
  assert.deepEqual(transitions.find((t) => t.from === 'Review' && t.verdict === 'failed'), { from: 'Review', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 2 });
  assert.deepEqual(transitions.filter((t) => t.from === 'Done'), [{ from: 'Done', to: DONE_STAGE, when: 'done' }]);
});

test('runStages: an arm that changes a continuing stage\'s agent starts a new session there (#925)', () => {
  const merged = mergeArm(SETUP, { stages: { Plan: { agent: 'codex' } } });
  assert.equal(runStages(merged.flow, 'claude').transitions.find((t) => t.to === 'Plan')?.session, 'new');
  assert.equal(runStages(SETUP.flow, 'claude').transitions.find((t) => t.to === 'Plan')?.session, undefined);
});

test('runConfig parses: the main config with the run comb, no branch template, the arm\'s env, rows and plugins in the Claude args (#471)', () => {
  const exp = experiment({ isolation: { ...ISOLATION, permissionMode: { all: 'dontAsk', perArm: { a2: 'acceptEdits' } } } });
  const config = parseConfig(runConfig(mainConfig(), exp, arm('a2', 'B', { plugins: ['/p/one'], rules: { allow: ['Bash(make:*)'], deny: ['Bash(curl:*)'] } }), 'abcd1234', PATHS));
  assert.equal(config.branch, undefined);
  assert.deepEqual([config.comb.prefix, config.baseBranch, config.comb.sources, config.comb.hiveSource], ['ABCD1234', 'work/abcd1234', [], true]);
  const args = config.agentArgs.claude.join(' ');
  for (const part of ['--permission-mode acceptEdits', '--max-turns 200', '--plugin-dir /p/one', 'Bash(make:*)', 'Bash(curl:*)']) assert.ok(args.includes(part), part);
  assert.deepEqual(config.agentArgs.codex, mainConfig().agentArgs.codex);
});

test('runState holds the tasks as local tasks under the token prefix in Spec, auto only when free of blockers, with the arm\'s worker cap (#471)', () => {
  const state = runState([{ key: 'T1', title: 'One', body: 'b', blockedBy: [] }, { key: 'T2', title: 'Two', body: 'c', blockedBy: ['T1'] }], 'abcd1234', 'hive', 3, 'Spec');
  assert.deepEqual(state.tasks.map((t) => [t.item.itemId, t.item.id, t.stage, t.auto, t.workspace]), [['local:1', 'ABCD1234-1', 'Spec', true, 'hive'], ['local:2', 'ABCD1234-2', 'Spec', false, 'hive']]);
  assert.deepEqual([state.maxConcurrent, state.workers.length, state.localCount], [3, 3, 2]);
});

test("watchTasks is the run's blocker graph as runState seeds it: local:<n> in seed order, blockers by their task's position (#472)", () => {
  assert.deepEqual(watchTasks([{ key: 'A', title: 'a', blockedBy: [] }, { key: 'B', title: 'b', blockedBy: ['A'] }]), [
    { itemId: 'local:1', key: 'A', title: 'a', blockedBy: [] },
    { itemId: 'local:2', key: 'B', title: 'b', blockedBy: ['local:1'] },
  ]);
});

test("an arm's Build agent leaves Spec alone, a later base edit of Spec reaches it, a missing stage's override is dropped (#536)", () => {
  const overrides: ArmOverrides = { stages: { Build: { agent: 'codex' }, Gone: { agent: 'codex' } } };
  const merged = mergeArm(SETUP, overrides);
  assert.equal(merged.flow.stages[2].agent, 'codex');
  assert.deepEqual(merged.flow.stages[0], SETUP.flow.stages[0]);
  assert.deepEqual(mergeArm(SETUP, { stages: { Gone: { agent: 'codex' } } }), SETUP);
  const edited = { ...SETUP, flow: { ...SETUP.flow, stages: SETUP.flow.stages.map((s) => (s.name === 'Spec' ? { ...s, model: 'opus' } : s)) } };
  assert.equal(mergeArm(edited, overrides).flow.stages[0].model, 'opus');
});

test("a null model is the agent's own default: the merged stage has none (#462, #536)", () => {
  const base = { ...SETUP, flow: { ...SETUP.flow, stages: SETUP.flow.stages.map((s) => (s.name === 'Build' ? { ...s, model: 'sonnet' } : s)) } };
  const build = mergeArm(base, { stages: { Build: { agent: 'codex', model: null } } }).flow.stages[2];
  assert.equal('model' in build, false);
});

test("a stage named like a prototype key reads no override, and an override holding flow never replaces the copy (#536)", () => {
  const overrides = JSON.parse('{"stages":{"constructor":{"agent":"codex"}},"flow":{"stages":[]}}') as ArmOverrides;
  assert.deepEqual(mergeArm(SETUP, overrides).flow, SETUP.flow);
});

test('runConfig parses with the copied flow, its commands enabled in the run\'s workspace; runState seeds the first stage (#536)', () => {
  const exp = experiment({ base: { ...SETUP, flow: copied() } });
  const config = parseConfig(runConfig(mainConfig(), exp, arm('a1', 'A'), 'abcd1234', PATHS));
  assert.deepEqual(config.comb.commands.map((c) => [c.name, c.impls]), [['test', [{ workspace: null, command: 'pnpm test' }]], ['lint', [{ workspace: null, command: 'pnpm lint' }]]]);
  assert.equal(config.comb.stages.at(-1)?.name, DONE_STAGE);
  const state = runState(SETUP.tasks, 'abcd1234', 'hive', 3, 'Spec');
  assert.deepEqual(state.tasks.map((t) => t.stage), ['Spec']);
});
