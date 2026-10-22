import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluateDeps } from '../../src/benchmark/evaluate.js';
import { createBenchEvaluator } from '../../src/benchmark/evaluate-service.js';
import type { BenchRunEvaluation, HiveEvent, State } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { experiment, run, stateWith } from './fixtures.js';

const AT = '2026-10-21T12:00:00.000Z';
const EVAL: BenchRunEvaluation = { at: AT, collectors: [], scenarios: [], judge: { agent: 'claude', rubricHash: 'abcdef012345', scores: [] } };
const STATE: State = stateWith(experiment({ rounds: [
  { n: 1, runs: [run('aaaa1', { status: 'done' }), run('aaaa2', { armId: 'a2', status: 'timeout' })] },
  { n: 2, runs: [run('bbbb1', { round: 2, status: 'done' }), run('bbbb2', { round: 2, armId: 'a2', status: 'running' })] },
] }));

function service(evaluateRun: (token: string, deps: EvaluateDeps) => Promise<BenchRunEvaluation | undefined>) {
  const events: HiveEvent[] = [];
  const { log, lines } = fakeLog();
  const evaluator = createBenchEvaluator({
    latest: () => STATE, dispatch: async (event) => { events.push(event); }, folderOf: (id) => `/hive/benchmark/${id}`, log, now: () => Date.parse(AT),
    runDeps: (signal) => ({ signal }) as EvaluateDeps, evaluateRun: (ctx, deps) => evaluateRun(ctx.run.token, deps),
  });
  return { evaluator, events, lines };
}

test("evaluate runs the tokens one at a time in order, dispatches each run's evaluation and every round whose ended runs it all evaluated; the tokens are evaluating until it ends (#474)", async () => {
  const order: string[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const { evaluator, events } = service(async (token) => { order.push(token); await gate; return EVAL; });
  const done = evaluator.evaluate('exp-1', ['aaaa1', 'aaaa2', 'bbbb1']);
  assert.deepEqual(['aaaa1', 'aaaa2', 'bbbb1', 'bbbb2'].map((token) => evaluator.isEvaluating(token)), [true, true, true, false]);
  open();
  await done;
  assert.deepEqual(order, ['aaaa1', 'aaaa2', 'bbbb1']);
  assert.deepEqual(events, [
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'aaaa1', patch: { evaluation: EVAL } },
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'aaaa2', patch: { evaluation: EVAL } },
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'bbbb1', patch: { evaluation: EVAL } },
    { type: 'benchmarkRoundEvaluated', id: 'exp-1', round: 1, at: AT },
    { type: 'benchmarkRoundEvaluated', id: 'exp-1', round: 2, at: AT }, // bbbb2 is still running: not an ended run of the round
  ]);
  assert.equal(evaluator.isEvaluating('aaaa1'), false);
});

test('a run whose judge failed or whose evaluation threw keeps its evaluation, leaves its round unevaluated and is logged by token only (#474)', async () => {
  const { evaluator, events, lines } = service(async (token) => {
    if (token === 'aaaa2') throw new Error('git diff: the whole patch');
    return token === 'bbbb1' ? undefined : EVAL;
  });
  await evaluator.evaluate('exp-1', ['aaaa1', 'aaaa2', 'bbbb1']);
  assert.deepEqual(events.map((e) => (e.type === 'benchmarkRunChanged' ? e.token : e.type)), ['aaaa1']);
  assert.deepEqual(lines.filter((l) => l.startsWith('WARN')), ['WARN benchmark exp-1 aaaa2: evaluation failed', 'WARN benchmark exp-1 bbbb1: evaluation failed']);
});

test('abortAll stops every evaluation: nothing is dispatched and the tokens are released (#474)', async () => {
  const { evaluator, events } = service((_token, deps) => new Promise((resolve) => deps.signal.addEventListener('abort', () => resolve(EVAL))));
  const done = evaluator.evaluate('exp-1', ['aaaa1', 'aaaa2']);
  evaluator.abortAll();
  await done;
  assert.deepEqual(events, []);
  assert.equal(evaluator.isEvaluating('aaaa1'), false);
});
