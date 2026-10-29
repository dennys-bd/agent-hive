import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFlow, flowIssues, overrideIssues } from '../../src/benchmark/flow-copy.js';
import type { BenchFlow, BenchStage, Stage } from '../../src/types.js';
import { BENCH_STAGES, benchComb, NOW } from './fixtures.js';

const flowOf = (result: ReturnType<typeof copyFlow>): BenchFlow => {
  assert.ok('flow' in result, JSON.stringify(result));
  return result.flow;
};

test("the user's flow copies without its source fields, approval and delete activity kept, agents frozen (#536)", () => {
  const flow = flowOf(copyFlow(benchComb(), 'bench', NOW));
  assert.equal(flow.copiedAt, NOW.toISOString());
  assert.deepEqual(flow.stages.map((s) => s.name), ['Spec', 'Plan', 'Build', 'Checks', 'Review', 'Done']);
  assert.ok(flow.stages.every((s) => !('from' in s) && !('onStart' in s) && !('after' in s)));
  assert.deepEqual(flow.stages[0], { name: 'Spec', prompt: '/hive:new-spec {id}', agent: 'codex', model: 'gpt-5' });
  assert.deepEqual([flow.stages[1].agent, flow.stages[2].agent, flow.stages[2].approval], ['claude', 'claude', true]);
  assert.equal(flow.stages[5].action, 'deleteActivity');
  assert.ok(flow.transitions.every((t) => !('sources' in t)));
  assert.deepEqual(flow.transitions.find((t) => t.from === 'Checks' && t.verdict === 'failed'), { from: 'Checks', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 3 });
  assert.deepEqual(flow.dropped, ['Spec.from', 'Spec.onStart', 'Done.after', 'Review → Done.sources']);
});

test("a commands stage's names resolve to the seed workspace's lines, the workspace's own first (#536)", () => {
  assert.deepEqual(flowOf(copyFlow(benchComb(), 'bench', NOW)).commands, [{ name: 'test', line: 'pnpm test' }, { name: 'lint', line: 'pnpm lint' }]);
  assert.deepEqual(flowOf(copyFlow(benchComb(), 'other', NOW)).commands.map((c) => c.line), ['pnpm test', 'npm run lint']);
});

test('a wait for CI refuses with its name; a stage named Delivered, an empty flow and a command with no line refuse too (#536)', () => {
  const withStage = (extra: Stage) => copyFlow(benchComb([...BENCH_STAGES, extra]), 'bench', NOW);
  assert.match((withStage({ name: 'CI', from: {}, action: 'waitForCi', ciChecks: 'all', rerunOnce: false }) as { refused: string }).refused, /CI waits for CI/);
  assert.match((withStage({ name: 'Delivered', from: {} }) as { refused: string }).refused, /Delivered/);
  assert.match((copyFlow(benchComb([]), 'bench', NOW) as { refused: string }).refused, /no stage/);
  const deploy: Stage = { name: 'Ship', from: {}, action: 'commands', commands: ['deploy'], stopOnFailure: true, onMissing: 'fail' };
  assert.match((withStage(deploy) as { refused: string }).refused, /Ship runs deploy, which has no line in workspace bench/);
});

test('flowIssues: an edit of the editable fields passes; a renamed stage, a moved transition or a foreign command does not (#536)', () => {
  const flow = flowOf(copyFlow(benchComb(), 'bench', NOW));
  const edit = (i: number, patch: Partial<BenchStage>): BenchFlow => ({ ...flow, stages: flow.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  assert.deepEqual(flowIssues(flow, edit(0, { agent: 'claude', model: 'opus', prompt: '/x {id}' })), []);
  assert.deepEqual(flowIssues(flow, edit(4, { judge: { agent: 'codex' }, threshold: 8 })), []);
  assert.match(flowIssues(flow, edit(0, { name: 'Other' }))[0], /structure/);
  const { approval: _approval, ...noApproval } = flow.stages[2];
  assert.match(flowIssues(flow, { ...flow, stages: flow.stages.map((s, j) => (j === 2 ? noApproval : s)) })[0], /structure/);
  assert.match(flowIssues(flow, { ...flow, transitions: flow.transitions.slice(1) })[0], /structure/);
  assert.match(flowIssues(flow, edit(3, { commands: ['deploy'] }))[0], /Checks: no line for command deploy/);
  assert.match(flowIssues(flow, edit(4, { threshold: 11 }))[0], /Review/);
  assert.match(flowIssues(flow, edit(0, { model: null as unknown as string }))[0], /Spec/);
});

test('overrideIssues: an override must name a stage of the flow, a command of the flow and fields that fit the stage action (#536)', () => {
  const flow = flowOf(copyFlow(benchComb(), 'bench', NOW));
  assert.deepEqual(overrideIssues(flow, { Spec: { agent: 'claude', model: null, prompt: 'x' }, Plan: { skill: 'new-build' }, Checks: { commands: ['lint'] }, Review: { judge: { agent: 'codex' }, threshold: 5 } }), []);
  assert.deepEqual(overrideIssues(flow, {}), []);
  assert.match(overrideIssues(flow, { Nope: { agent: 'claude' } })[0], /Nope: no such stage/);
  assert.match(overrideIssues(flow, { Checks: { commands: ['deploy'] } })[0], /Checks: no line for command deploy/);
  assert.match(overrideIssues(flow, { Checks: { agent: 'claude' } })[0], /Checks: agent does not fit/);
  assert.match(overrideIssues(flow, { Spec: { skill: 'x' } })[0], /Spec: skill does not fit/);
  assert.match(overrideIssues(flow, { Plan: { commands: ['test'] } })[0], /Plan: commands does not fit/);
  assert.match(overrideIssues(flow, { Spec: { threshold: 3 } })[0], /Spec: threshold does not fit/);
  assert.match(overrideIssues(flow, { Done: { model: 'opus' } })[0], /Done: model does not fit/);
});

test('flowIssues applies the same action fit to base edits (#536)', () => {
  const flow = flowOf(copyFlow(benchComb(), 'bench', NOW));
  const edit = (i: number, patch: Partial<BenchStage>): BenchFlow => ({ ...flow, stages: flow.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  assert.match(flowIssues(flow, edit(3, { agent: 'claude' }))[0], /Checks: agent does not fit/);
  assert.match(flowIssues(flow, edit(0, { threshold: 3 }))[0], /Spec: threshold does not fit/);
});

test('a copied flow never holds a stage named __proto__, which arms could not override (#536)', () => {
  const refused = copyFlow(benchComb([...BENCH_STAGES, { name: '__proto__', from: {} }]), 'bench', NOW);
  assert.match((refused as { refused: string }).refused, /__proto__/);
});

test('a stage copies without maxWorkers, recorded as dropped (#536)', () => {
  const flow = flowOf(copyFlow(benchComb([{ ...BENCH_STAGES[0], maxWorkers: 0 }, ...BENCH_STAGES.slice(1)]), 'bench', NOW));
  assert.ok(!('maxWorkers' in flow.stages[0]));
  assert.ok(flow.dropped.includes('Spec.maxWorkers'));
});
