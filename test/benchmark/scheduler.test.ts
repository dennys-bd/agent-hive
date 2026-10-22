import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkReduce } from '../../src/benchmark-reducer.js';
import { gateRefusal, missingRuns, runExperiment, type SchedulerDeps } from '../../src/benchmark/scheduler.js';
import type { WatchEnd } from '../../src/benchmark/watcher.js';
import type { BenchmarkEvent, Experiment, State } from '../../src/types.js';
import { experiment, run, stateWith, until } from './fixtures.js';

const AT = '2026-10-22T22:00:00.000Z';
const NOW = new Date(AT);
const { until: _until, ...PACE } = experiment().pace;
const TWO_PAIRS = experiment({ pace: { ...PACE, pairs: 2 } });
const ONE_PAIR = experiment({ pace: { ...PACE, pairs: 1 } });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Stubs {
  watch?(token: string, signal: AbortSignal, dispatch: (event: BenchmarkEvent) => Promise<void>): Promise<WatchEnd>;
  failBoot?: string[]; failEnd?: string[]; capReached?(calls: readonly string[]): boolean; deadline?: Date; awake?(): Promise<void>;
}

function harness(exp: Experiment, stubs: Stubs = {}) {
  let state: State = stateWith(exp);
  const events: BenchmarkEvent[] = [];
  const calls: string[] = [];
  const lines: string[] = [];
  const controller = new AbortController();
  let drawn = 0;
  const latest = (): Experiment | undefined => state.benchmark.experiments.find((e) => e.id === exp.id);
  const dispatch = async (event: BenchmarkEvent): Promise<void> => { events.push(event); state = benchmarkReduce(state, event); };
  const deps: SchedulerDeps = {
    latest, dispatch, now: () => NOW, deadline: () => stubs.deadline, capReached: () => stubs.capReached?.(calls) ?? false,
    awake: stubs.awake ?? (async () => undefined), log: (line) => lines.push(line), signal: controller.signal,
    startRun: async (_experiment, arm, round) => {
      drawn += 1;
      const token = `tok${drawn}`;
      calls.push(`start ${arm.id} r${round} ${token}`);
      await dispatch({ type: 'benchmarkRunStarted', id: exp.id, run: run(token, { armId: arm.id, round }) });
      return stubs.failBoot?.includes(arm.id) ? { token, failed: 'the daemon exited with 1' } : { token };
    },
    watch: async ({ token }) => { calls.push(`watch ${token}`); return (await stubs.watch?.(token, controller.signal, dispatch)) ?? { outcome: 'done' }; },
    endRun: async ({ token }, end) => {
      calls.push(`end ${token} ${end.outcome}`);
      if (stubs.failEnd?.includes(token)) throw new Error('metrics blew up');
      if (end.outcome === 'aborted') return;
      await dispatch({ type: 'benchmarkRunEnded', id: exp.id, token, status: end.outcome, at: AT, ...(end.outcome === 'error' ? { reason: end.reason } : {}) });
    },
    evaluate: async (tokens) => { calls.push(`evaluate ${tokens.join(',')}`); },
    report: async () => { calls.push('report'); },
  };
  return { deps, events, calls, lines, controller, latest };
}
const before = (calls: readonly string[], a: string, b: string): boolean => calls.includes(a) && calls.indexOf(a) < calls.indexOf(b);
const starts = (calls: readonly string[]): string[] => calls.filter((c) => c.startsWith('start'));

test('2 arms × 2 pairs: round 1 boots both runs, waits for both, evaluates both, then round 2 starts; the loop ends done (#472)', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(TWO_PAIRS, { watch: async (token) => { if (token === 'tok2') await held; return { outcome: 'done' }; } });
  const loop = runExperiment('exp-1', h.deps);
  await tick();
  assert.deepEqual(starts(h.calls), ['start a1 r1 tok1', 'start a2 r1 tok2']);
  assert.ok(!h.calls.some((c) => c.startsWith('evaluate')), 'no evaluation while a run of the round runs');
  release();
  await loop;
  assert.ok(before(h.calls, 'end tok2 done', 'evaluate tok1,tok2'));
  assert.ok(before(h.calls, 'evaluate tok1,tok2', 'report'));
  assert.ok(before(h.calls, 'report', 'start a1 r2 tok3'));
  assert.ok(h.calls.includes('evaluate tok3,tok4'));
  assert.deepEqual(h.events.flatMap((e) => (e.type === 'benchmarkRoundEnded' ? [e.round] : [])), [1, 2]);
  assert.deepEqual(h.events.at(-1), { type: 'benchmarkFinished', id: 'exp-1' });
  assert.equal(h.latest()?.status, 'done');
  assert.ok(h.lines.includes('benchmark exp-1: done'));
});

test("stopAfterRound set during round 1 ends the loop after round 1's evaluation with benchmarkFinished, the missing runs logged (#472)", async () => {
  const h = harness(TWO_PAIRS, { watch: async (token, _signal, dispatch) => {
    if (token === 'tok1') await dispatch({ type: 'benchmarkStopAfterRound', id: 'exp-1', on: true });
    return { outcome: 'done' };
  } });
  await runExperiment('exp-1', h.deps);
  assert.deepEqual(starts(h.calls), ['start a1 r1 tok1', 'start a2 r1 tok2']);
  assert.ok(before(h.calls, 'evaluate tok1,tok2', 'report'));
  assert.deepEqual(h.events.at(-1), { type: 'benchmarkFinished', id: 'exp-1' });
  assert.deepEqual([h.latest()?.status, h.latest()?.stopAfterRound], ['done', undefined]);
  assert.ok(h.lines.includes('benchmark exp-1: no new round: stop after round'));
  assert.ok(h.lines.includes('benchmark exp-1: done with 2 runs missing (rounds 2)'));
});

test('a watch ending timeout ends that run timeout; the round goes on and is evaluated with it (#472)', async () => {
  const h = harness(ONE_PAIR, { watch: async (token) => (token === 'tok1' ? { outcome: 'timeout' } : { outcome: 'done' }) });
  await runExperiment('exp-1', h.deps);
  assert.ok(h.calls.includes('end tok1 timeout'));
  assert.ok(h.calls.includes('evaluate tok1,tok2'));
  assert.deepEqual(h.latest()?.rounds[0].runs.map((r) => r.status), ['timeout', 'done']);
});

test('with until passed no round starts; with the cap reached after round 1 no round 2 starts; both end done with the missing runs logged (#472)', async () => {
  const late = harness(TWO_PAIRS, { deadline: NOW });
  await runExperiment('exp-1', late.deps);
  assert.deepEqual(late.calls, []);
  assert.equal(late.latest()?.status, 'done');
  assert.ok(late.lines.includes('benchmark exp-1: no new round: the until deadline passed'));
  assert.ok(late.lines.includes('benchmark exp-1: done with 4 runs missing (rounds 1, 2)'));
  const capped = harness(TWO_PAIRS, { capReached: (calls) => calls.includes('report') });
  await runExperiment('exp-1', capped.deps);
  assert.deepEqual(starts(capped.calls), ['start a1 r1 tok1', 'start a2 r1 tok2']);
  assert.ok(capped.lines.includes('benchmark exp-1: no new round: the spend cap is reached'));
  assert.equal(capped.latest()?.status, 'done');
});

test('an experiment with one interrupted run reruns only that run, in its round, with a new token (#472)', async () => {
  const resumed = experiment({ status: 'done', pace: { ...PACE, pairs: 1 }, rounds: [
    { n: 1, startedAt: AT, runs: [run('aaaa1', { status: 'done' }), run('aaaa2', { armId: 'a2', status: 'interrupted' })] },
  ] });
  const h = harness(resumed);
  await runExperiment('exp-1', h.deps);
  assert.deepEqual(h.calls, ['start a2 r1 tok1', 'watch tok1', 'end tok1 done', 'evaluate aaaa1,tok1', 'report']);
  assert.deepEqual(h.latest()?.rounds[0].runs.map((r) => [r.token, r.status]), [['aaaa1', 'done'], ['aaaa2', 'interrupted'], ['tok1', 'done']]);
});

test('a round whose runs all ended but which was never evaluated is evaluated before the walk goes on (#472)', async () => {
  const h = harness(experiment({ status: 'done', pace: { ...PACE, pairs: 2 }, rounds: [
    { n: 1, startedAt: AT, endedAt: AT, runs: [run('aaaa1', { status: 'done' }), run('aaaa2', { armId: 'a2', status: 'error' })] },
  ] }));
  await runExperiment('exp-1', h.deps);
  assert.deepEqual(h.calls.slice(0, 3), ['evaluate aaaa1,aaaa2', 'report', 'start a1 r2 tok1']);
});

test('a failing boot ends the run error with its reason, never watched; the round goes on (#472)', async () => {
  const h = harness(ONE_PAIR, { failBoot: ['a2'] });
  await runExperiment('exp-1', h.deps);
  assert.ok(!h.calls.includes('watch tok2'));
  assert.ok(h.calls.includes('end tok2 error'));
  assert.ok(h.calls.includes('evaluate tok1,tok2'));
  assert.deepEqual(h.latest()?.rounds[0].runs.map((r) => [r.status, r.reason]), [['done', undefined], ['error', 'the daemon exited with 1']]);
});

test('an abort dispatches nothing more: no run end, no round end, no evaluation, no finish (#472)', async () => {
  const h = harness(TWO_PAIRS, { watch: (_token, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }), { once: true })) });
  const loop = runExperiment('exp-1', h.deps);
  await tick();
  const seen = h.events.length;
  h.controller.abort();
  await loop;
  assert.equal(h.events.length, seen);
  assert.ok(!h.calls.some((c) => c.startsWith('end') || c.startsWith('evaluate') || c === 'report'));
});

test('no round starts while the experiment sleeps: the gate waits for awake (#472)', async () => {
  let wake: () => void = () => undefined;
  const asleep = new Promise<void>((resolve) => { wake = resolve; });
  const h = harness(ONE_PAIR, { awake: () => asleep });
  const loop = runExperiment('exp-1', h.deps);
  await tick();
  assert.deepEqual(h.calls, []);
  wake();
  await loop;
  assert.deepEqual(starts(h.calls), ['start a1 r1 tok1', 'start a2 r1 tok2']);
});

test('a run whose watch ends aborted while the loop is not (wake found it gone) is booted again after its round, as often as a wake finds it gone (#472)', async () => {
  const h = harness(ONE_PAIR, { watch: async (token, _signal, dispatch) => {
    if (token === 'tok2' || token === 'tok4') return { outcome: 'done' };
    await dispatch({ type: 'benchmarkRunChanged', id: 'exp-1', token, patch: { status: 'interrupted' } });
    return { outcome: 'aborted' };
  } });
  await runExperiment('exp-1', h.deps);
  assert.deepEqual(starts(h.calls), ['start a1 r1 tok1', 'start a2 r1 tok2', 'start a1 r1 tok3', 'start a1 r1 tok4']);
  assert.equal(h.latest()?.status, 'done');
});

test('a wake that finds every live run of the round gone reruns all of them with new tokens instead of finishing (#472)', async () => {
  const h = harness(ONE_PAIR, { watch: async (token, _signal, dispatch) => {
    if (token !== 'tok1' && token !== 'tok2') return { outcome: 'done' };
    await dispatch({ type: 'benchmarkRunChanged', id: 'exp-1', token, patch: { status: 'interrupted' } });
    return { outcome: 'aborted' };
  } });
  await runExperiment('exp-1', h.deps);
  assert.deepEqual(starts(h.calls), ['start a1 r1 tok1', 'start a2 r1 tok2', 'start a1 r1 tok3', 'start a2 r1 tok4']);
  assert.deepEqual(missingRuns(h.latest() as Experiment), []);
});

test('the loop waits for the gate before finishing, and a more-rounds that lands meanwhile still runs (#472)', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let hold = false;
  const h = harness(ONE_PAIR, { awake: async () => { if (hold) await held; } });
  h.deps.report = async () => { h.calls.push('report'); hold = true; }; // the sleep lands during the last evaluation
  const loop = runExperiment('exp-1', h.deps);
  await until(() => h.calls.includes('report'));
  await tick();
  assert.equal(h.events.some((e) => e.type === 'benchmarkFinished'), false);
  hold = false;
  await h.deps.dispatch({ type: 'benchmarkEdited', id: 'exp-1', patch: { pace: { ...ONE_PAIR.pace, pairs: 2 } } });
  release();
  await loop;
  assert.deepEqual(starts(h.calls), ['start a1 r1 tok1', 'start a2 r1 tok2', 'start a1 r2 tok3', 'start a2 r2 tok4']);
  assert.equal(h.events.filter((e) => e.type === 'benchmarkFinished').length, 1);
});

test("missingRuns: per round up to pace.pairs and per arm, none yet or the arm's latest interrupted; an error run is not missing. gateRefusal's order (#472)", () => {
  const exp = experiment({ pace: { ...PACE, pairs: 2 }, rounds: [
    { n: 1, runs: [run('aaaa1', { status: 'error' }), run('aaaa2', { armId: 'a2', status: 'interrupted' }), run('aaaa3', { armId: 'a2', status: 'done' })] },
    { n: 2, runs: [run('bbbb1', { round: 2, status: 'interrupted' })] },
    { n: 3, runs: [] },
  ] });
  assert.deepEqual(missingRuns(exp), [{ round: 2, armId: 'a1' }, { round: 2, armId: 'a2' }]);
  const later = new Date(NOW.getTime() + 1);
  assert.equal(gateRefusal({ ...exp, stopAfterRound: true }, NOW, later, true), 'stop after round');
  assert.equal(gateRefusal(exp, NOW, NOW, true), 'the until deadline passed');
  assert.equal(gateRefusal(exp, NOW, later, true), 'the spend cap is reached');
  assert.equal(gateRefusal(exp, NOW, undefined, false), undefined);
});

test('a run whose end throws is ended error with a reason, so its round still ends and nothing stays running (#472)', async () => {
  const h = harness(ONE_PAIR, { failEnd: ['tok1'] });
  await runExperiment('exp-1', h.deps);
  const runs = h.latest()?.rounds[0].runs ?? [];
  assert.deepEqual(runs.map((r) => [r.token, r.status]), [['tok1', 'error'], ['tok2', 'done']]);
  assert.ok(runs[0].reason);
  assert.equal(h.latest()?.status, 'done');
});
