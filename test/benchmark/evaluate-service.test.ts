import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluateDeps } from '../../src/benchmark/evaluate.js';
import type { Run } from '../../src/benchmark/exec.js';
import { defaultEvaluation } from '../../src/benchmark/new-experiment.js';
import type { EvaluateContext } from '../../src/benchmark/evaluate.js';
import { benchRunDeps, createBenchEvaluator, readyFetch } from '../../src/benchmark/evaluate-service.js';
import type { BenchRunEvaluation, HiveEvent, State } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { experiment, run, stateWith } from './fixtures.js';

const AT = '2026-10-21T12:00:00.000Z';
const EVAL: BenchRunEvaluation = { at: AT, collectors: [], scenarios: [], judge: { agent: 'claude', rubricHash: 'abcdef012345', scores: [] } };
const STATE: State = stateWith(experiment({ rounds: [
  { n: 1, runs: [run('aaaa1', { status: 'done' }), run('aaaa2', { armId: 'a2', status: 'timeout' })] },
  { n: 2, runs: [run('bbbb1', { round: 2, status: 'done' }), run('bbbb2', { round: 2, armId: 'a2', status: 'running' })] },
] }));

const LIVE = { agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true } };

function service(evaluateRun: (token: string, deps: EvaluateDeps) => Promise<BenchRunEvaluation | undefined>, abortWaitMs?: number) {
  const events: HiveEvent[] = [];
  const { log, lines } = fakeLog();
  const evaluator = createBenchEvaluator({
    latest: () => STATE, config: () => LIVE, dispatch: async (event) => { events.push(event); }, folderOf: (id) => `/hive/benchmark/${id}`, log, now: () => Date.parse(AT), ...(abortWaitMs === undefined ? {} : { abortWaitMs }),
    runDeps: (signal) => ({ signal }) as EvaluateDeps, evaluateRun: (ctx, deps) => evaluateRun(ctx.run.token, deps),
  });
  return { evaluator, events, lines };
}

test("evaluate runs the tokens one at a time in order, dispatches each run's evaluation and every round whose ended runs it all evaluated; the tokens are evaluating until it ends (#474)", async () => {
  const order: string[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const { evaluator, events } = service(async (token) => { order.push(token); await gate; return EVAL; });
  const done = evaluator.evaluate('exp-1', ['aaaa1', 'aaaa2', 'bbbb1'], true);
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
  await evaluator.abortAll();
  assert.equal(evaluator.isEvaluating('aaaa1'), false, 'abortAll resolves only after the evaluation unwound');
  await done;
  assert.deepEqual(events, []);
});

test('abortAll waits for the cleanup of an aborted evaluation (#474)', async () => {
  let cleaned = false;
  const { evaluator } = service((_token, deps) => new Promise((_resolve, reject) => deps.signal.addEventListener('abort', () => { setTimeout(() => { cleaned = true; reject(new Error('aborted')); }, 20); })));
  const done = evaluator.evaluate('exp-1', ['aaaa1']);
  await evaluator.abortAll();
  assert.equal(cleaned, true);
  await done;
});

test('abortAll stops waiting after the bound and logs one fixed line; evaluate starts nothing once it was called (#474)', async () => {
  let starts = 0;
  const { evaluator, lines } = service(() => { starts += 1; return new Promise(() => undefined); }, 20); // ignores the signal, never settles
  void evaluator.evaluate('exp-1', ['aaaa1']);
  await evaluator.abortAll();
  assert.deepEqual(lines.filter((l) => l.startsWith('WARN')), ['WARN benchmark evaluations did not stop in time']);
  await evaluator.evaluate('exp-1', ['aaaa2']); // resolves at once: closing
  assert.equal(starts, 1);
  assert.equal(evaluator.isEvaluating('aaaa2'), false);
});

test('a single-run evaluation dispatches its run but no benchmarkRoundEvaluated; only the experiment route asks for it (#474)', async () => {
  const { evaluator, events } = service(async () => EVAL);
  await evaluator.evaluate('exp-1', ['aaaa1', 'aaaa2']);
  assert.deepEqual(events.map((e) => e.type), ['benchmarkRunChanged', 'benchmarkRunChanged']);
});

test('benchRunDeps serializes git through one runner shared by every evaluation (#474)', async () => {
  let running = 0;
  let overlap = false;
  const exec: Run = async () => { running += 1; overlap ||= running > 1; await new Promise((resolve) => setTimeout(resolve, 5)); running -= 1; return { stdout: '' }; };
  const make = benchRunDeps({ exec });
  const a = make(new AbortController().signal, () => undefined);
  const b = make(new AbortController().signal, () => undefined);
  await Promise.all([a.exec('git', ['x']), b.exec('git', ['y']), a.exec('git', ['z'])]);
  assert.equal(overlap, false);
});

test('readyFetch answers the status and cancels the body so the poll holds no socket (#474)', async () => {
  let cancelled = false;
  const body = { cancel: async () => { cancelled = true; } };
  const res = await readyFetch('http://127.0.0.1:1/', { signal: new AbortController().signal }, async () => ({ status: 200, body }) as Response);
  assert.deepEqual(res, { status: 200 });
  assert.equal(cancelled, true);
});

test('an evaluation runs each collector, the tester and the judge with no model on its agent\'s default model, read when it starts; a named model is kept (#482)', async () => {
  const evaluation = { ...defaultEvaluation('claude'), collectors: [{ agent: 'claude' as const }, { agent: 'codex' as const }] };
  const state = stateWith(experiment({ evaluation, rounds: [{ n: 1, runs: [run('aaaa1', { status: 'done' })] }] }));
  const seen: EvaluateContext[] = [];
  const evaluator = createBenchEvaluator({
    latest: () => state, dispatch: async () => undefined, folderOf: (id) => `/hive/benchmark/${id}`, log: fakeLog().log, now: () => Date.parse(AT),
    config: () => ({ ...LIVE, agentModels: { claude: 'opus', codex: null } }),
    runDeps: (signal) => ({ signal }) as EvaluateDeps, evaluateRun: async (ctx) => { seen.push(ctx); return EVAL; },
  });
  await evaluator.evaluate('exp-1', ['aaaa1']);
  const used = seen[0].experiment.evaluation;
  assert.deepEqual([used.collectors.map((c) => c.model), used.tester.model, used.judge.model], [['opus', undefined], 'sonnet', 'opus']);
});

test('an evaluation whose collector, tester or judge names a disabled agent, or that starts with no live config, is refused before any run: no evaluateRun, a warning with the reason (#482)', async () => {
  const evaluation = { ...defaultEvaluation('claude'), collectors: [{ agent: 'claude' as const }, { agent: 'codex' as const }] };
  const state = stateWith(experiment({ evaluation, rounds: [{ n: 1, runs: [run('aaaa1', { status: 'done' })] }] }));
  for (const [config, reason] of [[() => ({ ...LIVE, agentEnabled: { claude: true, codex: false } }), 'agent codex is disabled'], [() => undefined, 'no live configuration']] as const) {
    const { log, lines } = fakeLog();
    let called = false;
    const events: HiveEvent[] = [];
    const evaluator = createBenchEvaluator({
      latest: () => state, dispatch: async (e) => { events.push(e); }, folderOf: (id) => `/hive/benchmark/${id}`, log, now: () => Date.parse(AT), config,
      runDeps: (signal) => ({ signal }) as EvaluateDeps, evaluateRun: async () => { called = true; return EVAL; },
    });
    await evaluator.evaluate('exp-1', ['aaaa1'], true);
    assert.equal(called, false);
    assert.deepEqual(events, []);
    assert.match(lines.filter((l) => l.startsWith('WARN')).join('\n'), new RegExp(`benchmark exp-1 aaaa1: .*${reason}`));
  }
});
