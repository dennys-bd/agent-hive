import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFlow, flowIssues, overrideIssues } from '../../src/benchmark/flow-copy.js';
import type { BenchFlow, BenchStage, Stage, Transition } from '../../src/types.js';
import { mainFlows } from '../fixtures/main-flow.js';
import { BENCH_STAGES, benchComb, NOW } from './fixtures.js';

const flowOf = (result: ReturnType<typeof copyFlow>): BenchFlow => {
  assert.ok('flow' in result, JSON.stringify(result));
  return result.flow;
};

test("the user's flow copies without its source fields and its gate, delete activity kept, agents frozen (#536, #672)", () => {
  const flow = flowOf(copyFlow(benchComb(), 'bench', NOW));
  assert.equal(flow.copiedAt, NOW.toISOString());
  assert.deepEqual(flow.stages.map((s) => s.name), ['Spec', 'Plan', 'Build', 'Checks', 'Review', 'Done']);
  assert.ok(flow.stages.every((s) => !('from' in s) && !('onStart' in s) && !('after' in s)));
  assert.deepEqual(flow.stages[0], { name: 'Spec', prompt: '/hive:new-spec {id}', agent: 'codex', model: 'gpt-5' });
  assert.deepEqual([flow.stages[1].agent, flow.stages[2].agent, 'approval' in flow.stages[2]], ['claude', 'claude', false]);
  assert.equal(flow.stages[5].action, 'deleteActivity');
  assert.ok(flow.transitions.every((t) => !('sources' in t)));
  assert.deepEqual(flow.transitions.filter((t) => t.from === 'Build'), [{ from: 'Build', to: 'Checks', when: 'done' }]);
  assert.deepEqual(flow.transitions.find((t) => t.from === 'Checks' && t.verdict === 'failed'), { from: 'Checks', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 3 });
  assert.deepEqual(flow.dropped, ['Spec.from', 'Spec.onStart', 'Build.approval', 'Done.after', 'Build → Build.feedback', 'Review → Done.sources']);
});

test("a commands stage's names resolve to the seed workspace's lines, the workspace's own first (#536)", () => {
  assert.deepEqual(flowOf(copyFlow(benchComb(), 'bench', NOW)).commands, [{ name: 'test', line: 'pnpm test' }, { name: 'lint', line: 'pnpm lint' }]);
  assert.deepEqual(flowOf(copyFlow(benchComb(), 'other', NOW)).commands.map((c) => c.line), ['pnpm test', 'npm run lint']);
});

test('a stage named Delivered, an empty flow and a command with no line refuse (#536)', () => {
  const withStage = (extra: Stage) => copyFlow(benchComb([...BENCH_STAGES, extra]), 'bench', NOW);
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
  assert.match(flowIssues(flow, edit(0, { approval: true }))[0], /structure/);
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

const combOf = (stages: Stage[], transitions: Transition[]): ReturnType<typeof benchComb> =>
  ({ ...benchComb(), comb: { ...benchComb().comb, flows: mainFlows(stages, transitions) } });
const refusedOf = (result: ReturnType<typeof copyFlow>): string => {
  assert.ok('refused' in result, JSON.stringify(result));
  return result.refused;
};
const CI: Stage = { name: 'CI', from: {}, action: 'waitForCi', ciChecks: 'all', rerunOnce: false };
const CI_STAGES: Stage[] = [{ name: 'Dev', from: {}, prompt: '/hive:new-build {id}' }, CI, { name: 'In Review', from: {}, prompt: '/hive:new-pr {id}' }];
const CI_TRANSITIONS: Transition[] = [
  { from: 'Dev', to: 'CI', when: 'done', maxTries: 2 },
  { from: 'CI', to: 'In Review', when: 'verdict', verdict: 'passed', prompt: 'CI is green: {id}' },
  { from: 'CI', to: 'Dev', when: 'verdict', verdict: 'failed' },
  { from: 'In Review', to: 'end', when: 'done' },
];

test('a wait for CI is skipped: what entered it goes to its passed exit, with the exit prompt unless it has its own, listed as skipped (#672)', () => {
  const flow = flowOf(copyFlow(combOf(CI_STAGES, CI_TRANSITIONS), 'bench', NOW));
  assert.deepEqual(flow.stages.map((s) => s.name), ['Dev', 'In Review']);
  assert.deepEqual(flow.transitions, [
    { from: 'Dev', to: 'In Review', when: 'done', maxTries: 2, prompt: 'CI is green: {id}' },
    { from: 'In Review', to: 'end', when: 'done' },
  ]);
  assert.deepEqual(flow.dropped, ['CI (waits for CI): skipped']);
  const own = CI_TRANSITIONS.map((t) => (t.from === 'Dev' ? { ...t, prompt: 'mine {id}', session: 'new' as const } : t));
  assert.deepEqual(flowOf(copyFlow(combOf(CI_STAGES, own), 'bench', NOW)).transitions[0], { from: 'Dev', to: 'In Review', when: 'done', maxTries: 2, prompt: 'mine {id}', session: 'new' });
});

test('a wait for CI refuses the copy with no passed exit, a passed exit into another wait, a session that continues it, or a doubled exit (#672)', () => {
  const noPassed = CI_TRANSITIONS.filter((t) => t.verdict !== 'passed');
  assert.match(refusedOf(copyFlow(combOf(CI_STAGES, noPassed), 'bench', NOW)), /stage CI waits for CI and has no passed exit/);
  const second: Stage = { ...CI, name: 'CI2' };
  const chained = [...CI_TRANSITIONS.map((t) => (t.from === 'CI' && t.verdict === 'passed' ? { ...t, to: 'CI2' } : t)), { from: 'CI2', to: 'In Review', when: 'verdict' as const, verdict: 'passed' }];
  assert.match(refusedOf(copyFlow(combOf([...CI_STAGES, second], chained), 'bench', NOW)), /stage CI passes into CI2, which waits for CI too/);
  const resumes: Transition = { from: 'In Review', to: 'Dev', when: 'verdict', verdict: 'changes', session: { continueOf: 'CI' } };
  assert.match(refusedOf(copyFlow(combOf(CI_STAGES, [...CI_TRANSITIONS, resumes]), 'bench', NOW)), /In Review → Dev continues the session of CI/);
  const doubled: Transition = { from: 'Dev', to: 'In Review', when: 'done' };
  assert.match(refusedOf(copyFlow(combOf(CI_STAGES, [...CI_TRANSITIONS, doubled]), 'bench', NOW)), /stage Dev has two exits on done/);
});

test("a copy drops every gate but a decomposition skill stage's: its approved exits become done, its feedback goes, each listed (#672)", () => {
  const stages: Stage[] = [
    { name: 'Router', from: {}, prompt: '/route {id}', verdicts: ['decompose', 'spec'] },
    { name: 'decompose', from: {}, action: 'skill', skill: 'decomposition', approval: true },
    { name: 'Spec', from: {}, prompt: '/hive:new-spec {id}', approval: true },
  ];
  const transitions: Transition[] = [
    { from: 'Router', to: 'decompose', when: 'verdict', verdict: 'decompose' }, { from: 'Router', to: 'Spec', when: 'verdict', verdict: 'spec' },
    { from: 'decompose', to: 'Spec', when: 'approved' }, { from: 'Spec', to: 'end', when: 'approved' }, { from: 'Spec', to: 'Spec', when: 'feedback' },
  ];
  const flow = flowOf(copyFlow(combOf(stages, transitions), 'bench', NOW));
  assert.equal(flow.stages[1].approval, true, 'the decompose gate stays: its hive write is the user press');
  assert.equal('approval' in flow.stages[2], false);
  assert.deepEqual(flow.transitions.slice(2), [{ from: 'decompose', to: 'Spec', when: 'approved' }, { from: 'Spec', to: 'end', when: 'done' }]);
  assert.deepEqual(flow.dropped, ['Spec.approval', 'Spec → Spec.feedback']);
});
