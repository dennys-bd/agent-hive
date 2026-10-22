import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeArm, resolveRow, runConfig, runStages, runState, watchTasks } from '../../src/benchmark/arm-config.js';
import { parseConfig } from '../../src/config.js';
import type { ArmOverrides } from '../../src/types.js';
import { arm, experiment, ISOLATION, mainConfig, SETUP } from './fixtures.js';

const PATHS = { clone: '/hive/benchmark/exp-1/clone', home: '/hive/benchmark/exp-1/runs/abcd1234', rules: { home: '/hive/benchmark/exp-1/runs/abcd1234', homes: ['/hive'], denied: [] } };

test('mergeArm takes an override key whole; resolveRow takes the arm\'s value, else the row\'s, never a prototype key (#471)', () => {
  assert.deepEqual(mergeArm(SETUP, { items: { 'hive:new-spec': 'terse' } }), { ...SETUP, items: { 'hive:new-spec': 'terse' } });
  assert.equal(mergeArm(SETUP, {}).worktree, SETUP.worktree);
  const row = { all: 'a', perArm: { a2: 'b' } };
  assert.deepEqual([resolveRow(row, 'a2'), resolveRow(row, 'a1'), resolveRow(row, 'constructor')], ['b', 'a', 'a']);
});

test('runStages chains Spec, Plan, Build, PR into Done, continuing a session only under the same agent (#471, #925)', () => {
  const { stages, transitions } = runStages({ ...SETUP.stages, build: { agent: 'codex', skill: '/x', prompt: 'B' } });
  assert.deepEqual(stages.map((s) => [s.name, s.agent, s.session]), [['Spec', 'claude', undefined], ['Plan', 'claude', 'continue'], ['Build', 'codex', undefined], ['PR', 'claude', undefined], ['Done', undefined, undefined]]);
  assert.deepEqual(transitions.map((x) => `${x.from}>${x.to}:${x.when}`), ['Spec>Plan:done', 'Plan>Build:done', 'Build>PR:done', 'PR>Done:done']);
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
  const state = runState([{ key: 'T1', title: 'One', body: 'b', blockedBy: [] }, { key: 'T2', title: 'Two', body: 'c', blockedBy: ['T1'] }], 'abcd1234', 'hive', 3);
  assert.deepEqual(state.tasks.map((t) => [t.item.itemId, t.item.id, t.stage, t.auto, t.workspace]), [['local:1', 'ABCD1234-1', 'Spec', true, 'hive'], ['local:2', 'ABCD1234-2', 'Spec', false, 'hive']]);
  assert.deepEqual([state.maxConcurrent, state.workers.length, state.localCount], [3, 3, 2]);
});

test("watchTasks is the run's blocker graph as runState seeds it: local:<n> in seed order, blockers by their task's position (#472)", () => {
  assert.deepEqual(watchTasks([{ key: 'A', title: 'a', blockedBy: [] }, { key: 'B', title: 'b', blockedBy: ['A'] }]), [
    { itemId: 'local:1', key: 'A', title: 'a', blockedBy: [] },
    { itemId: 'local:2', key: 'B', title: 'b', blockedBy: ['local:1'] },
  ]);
});

test('mergeArm merges stages per role and field: a build-only agent keeps the build model and the other stages, and a later base edit of spec reaches the arm (#462)', () => {
  const base = { ...SETUP, stages: { ...SETUP.stages, build: { ...SETUP.stages.build, model: 'sonnet' } } };
  const overrides: ArmOverrides = { stages: { build: { agent: 'codex' } } };
  assert.deepEqual(mergeArm(base, overrides).stages, { ...base.stages, build: { ...base.stages.build, agent: 'codex' } });
  const edited = { ...base, stages: { ...base.stages, spec: { ...base.stages.spec, model: 'opus' } } };
  assert.equal(mergeArm(edited, overrides).stages.spec.model, 'opus');
  assert.equal(mergeArm(edited, overrides).stages.build.model, 'sonnet');
  assert.deepEqual(mergeArm(base, { plugins: ['/p'] }).stages, base.stages);
});

test("mergeArm reads a null model as the agent's own default: the merged build has no model, the base's dropped (#462)", () => {
  const base = { ...SETUP, stages: { ...SETUP.stages, build: { ...SETUP.stages.build, model: 'sonnet' } } };
  const build = mergeArm(base, { stages: { build: { agent: 'codex', model: null } } }).stages.build;
  assert.deepEqual(build, { agent: 'codex', skill: base.stages.build.skill, prompt: base.stages.build.prompt });
  assert.equal('model' in build, false);
});
