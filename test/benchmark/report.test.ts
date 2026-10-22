import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, type ArmColumn, type SpreadCell } from '../../src/benchmark/report.js';
import type { Arm, ArmSetup, BenchMetrics, BenchRun, BenchRunEvaluation, Experiment } from '../../src/types.js';
import { arm, deepFreeze, experiment, run, SETUP } from './fixtures.js';

// The relatorio screen of docs/agent/design/benchmark.hv.html as an experiment: four arms over three full rounds, every arm's three values
// picked so its median and range are the screen's. The screen's samples the rules cannot give are said where they are asserted.
const MIN = 60_000;
const AT = '2026-10-22T08:00:00.000Z';
const NOW = Date.parse('2026-10-22T09:00:00.000Z');
const SLEPT_MS = 125 * MIN; // round 2 slept 2h05
const RUBRIC_HASH = 'r'.repeat(64);
const DIMENSIONS = ['fidelity', 'behavior', 'code', 'spec and plan', 'tests'];
const SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((id) => ({ id, title: id, text: '' }));
const INTERVENED = ['7d03b2', 'e30b71'];

type Row = [token: string, armId: string, round: number, status: 'done' | 'timeout', tokens: number, costUsd: number, minutes: number,
  waitingMinutes: number, restarts: number, diff: [insertions: number, deletions: number, files: number], green: boolean, clicks: number, scores: number[]];
const ROWS: Row[] = [
  ['aaaa01', 'arm-a', 1, 'done', 2_800_000, 37, 310, 14, 1, [4000, 600, 36], true, 6, [4, 3, 4, 3, 4]],
  ['aaaa02', 'arm-a', 2, 'done', 3_100_000, 41, 332, 22, 2, [4120, 610, 38], true, 5, [4, 4, 4, 3, 4]],
  ['aaaa03', 'arm-a', 3, 'done', 3_400_000, 45, 350, 30, 3, [4300, 650, 40], true, 5, [5, 4, 4, 4, 4]],
  ['7d03b2', 'arm-b', 1, 'done', 2_500_000, 33, 288, 18, 1, [3480, 540, 33], true, 6, [4, 5, 4, 4, 4]],
  ['bbbb02', 'arm-b', 2, 'done', 2_200_000, 29, 270, 9, 0, [3400, 500, 31], true, 6, [4, 4, 4, 4, 4]],
  ['bbbb03', 'arm-b', 3, 'done', 2_700_000, 36, 305, 25, 2, [3600, 560, 35], true, 5, [5, 5, 4, 5, 4]],
  ['e30b71', 'arm-c', 1, 'timeout', 2_900_000, 36, 360, 31, 4, [3900, 700, 36], false, 4, [3, 3, 4, 4, 3]],
  ['cccc02', 'arm-c', 2, 'done', 2_700_000, 34, 340, 20, 3, [3800, 650, 35], true, 4, [3, 2, 3, 4, 2]],
  ['cccc03', 'arm-c', 3, 'timeout', 3_000_000, 38, 360, 40, 5, [4100, 720, 38], false, 3, [4, 4, 4, 4, 3]],
  ['dddd01', 'arm-d', 1, 'done', 2_000_000, 26, 245, 8, 1, [3500, 560, 32], true, 5, [3, 3, 4, 2, 3]],
  ['dddd02', 'arm-d', 2, 'done', 2_200_000, 29, 260, 12, 2, [3610, 590, 34], true, 5, [4, 4, 4, 3, 3]],
  ['dddd03', 'arm-d', 3, 'done', 2_500_000, 33, 280, 20, 3, [3700, 620, 36], false, 5, [4, 5, 4, 3, 4]],
];

function benchRun([token, armId, round, status, tokens, costUsd, minutes, waitingMinutes, restarts, [insertions, deletions, files], green, clicks, scores]: Row): BenchRun {
  const metrics: BenchMetrics = {
    tokens, costUsd, ms: minutes * MIN, waitingMs: waitingMinutes * MIN, restarts: { count: restarts, where: [] },
    diff: { files, insertions, deletions }, tests: { green: green ? 10 : 7, total: 10 }, tasks: [],
  };
  const evaluation: BenchRunEvaluation = {
    at: AT, collectors: [], scenarios: SCENARIOS.map(({ id }, i) => ({ id, passed: i < clicks ? 1 : 0, total: 1, screenshots: [] })),
    judge: { agent: 'claude', model: 'fable', rubricHash: RUBRIC_HASH, scores: DIMENSIONS.map((dimension, i) => ({ dimension, score: scores[i], evidence: '' })) },
  };
  return run(token, {
    armId, round, status, endedAt: AT, sleptMs: round === 2 ? SLEPT_MS : 0, delivered: 1, total: 1, metrics, evaluation,
    interventions: INTERVENED.includes(token) ? [{ at: AT, action: 'POST /tasks/HIVE-2/restart', detail: '', by: 'user' }] : [],
  });
}

const named = (id: string, letter: string, name: string, overrides: Partial<ArmSetup> = {}): Arm => ({ ...arm(id, letter, overrides), name });
// C restates the base's tasks (still the same problem); D has its own, so it is compared only per run
const fixture = (): Experiment => experiment({
  status: 'done',
  arms: [
    named('arm-a', 'A', 'repo commands'), named('arm-b', 'B', 'plugin skills'), named('arm-c', 'C', 'plugin + codex', { tasks: SETUP.tasks }),
    named('arm-d', 'D', 'tasks together', { tasks: [{ key: 'T1', title: 'Every task at once', body: 'b', blockedBy: [] }] }),
  ],
  rounds: [1, 2, 3].map((n) => ({ n, runs: ROWS.filter((row) => row[2] === n).map(benchRun) })),
  seed: { ...experiment().seed, scenarios: SCENARIOS },
  evaluation: { ...experiment().evaluation, judge: { agent: 'claude', model: 'fable' } },
  sleeps: [{ round: 2, at: '2026-10-21T23:00:00.000Z', wokeAt: '2026-10-22T01:05:00.000Z', reason: 'need the machine for something else' }],
});

const withRun = (e: Experiment, token: string, patch: Partial<BenchRun>): Experiment =>
  ({ ...e, rounds: e.rounds.map((r) => ({ ...r, runs: r.runs.map((x) => (x.token === token ? { ...x, ...patch } : x)) })) });
const c = (median: number, min: number, max: number, best = false, n = 3): SpreadCell =>
  ({ value: { median, min, max, n }, ...(best ? { best: true as const } : {}) });
const cells = <C>(a: C, b: C, cc: C, d: C): Record<string, C> => ({ 'arm-a': a, 'arm-b': b, 'arm-c': cc, 'arm-d': d });
const col = (armId: string, letter: string, name: string, patch: Partial<ArmColumn> = {}): ArmColumn =>
  ({ armId, letter, name, runs: 3, inMedian: 3, intervened: 0, out: 0, slept: 1, onlyPerRun: false, ...patch });

test('the aggregate of three full rounds: the columns, the intervened runs in round order, the sleep, the judge, no unpaired run (#476)', () => {
  const report = aggregate(fixture(), 'in', NOW);
  assert.deepEqual([report.experimentId, report.filter, report.rounds, report.unpaired, report.mixedRubrics], ['exp-1', 'in', 3, [], false]);
  assert.deepEqual(report.judge, { agent: 'claude', model: 'fable' });
  assert.deepEqual(report.arms, [
    col('arm-a', 'A', 'repo commands'), col('arm-b', 'B', 'plugin skills', { intervened: 1 }),
    col('arm-c', 'C', 'plugin + codex', { intervened: 1 }), col('arm-d', 'D', 'tasks together', { onlyPerRun: true }),
  ]);
  assert.deepEqual(report.intervened, [{ token: '7d03b2', letter: 'B', inMedian: true }, { token: 'e30b71', letter: 'C', inMedian: true }]);
  assert.deepEqual(report.sleeps, [{ round: 2, times: 1, ms: SLEPT_MS, reasons: ['need the machine for something else'] }]);
  assert.deepEqual([report.clicks.first, report.clicks.last], ['S1', 'S6']);
});

test("with in, the execution rows are the screen's: medians and ranges, C's time with two timeouts, D best on four rows and B on restarts (#476)", () => {
  const { execution: x } = aggregate(fixture(), 'in', NOW);
  assert.deepEqual(x.tokens.cells, cells(c(3_100_000, 2_800_000, 3_400_000), c(2_500_000, 2_200_000, 2_700_000), c(2_900_000, 2_700_000, 3_000_000), c(2_200_000, 2_000_000, 2_500_000, true)));
  assert.deepEqual(x.cost.cells, cells(c(41, 37, 45), c(33, 29, 36), c(36, 34, 38), c(29, 26, 33, true)));
  assert.deepEqual(x.time.cells, cells(c(332 * MIN, 310 * MIN, 350 * MIN), c(288 * MIN, 270 * MIN, 305 * MIN), { ...c(360 * MIN, 340 * MIN, 360 * MIN), timeouts: 2 }, c(260 * MIN, 245 * MIN, 280 * MIN, true)));
  assert.deepEqual(x.waiting.cells, cells(c(22 * MIN, 14 * MIN, 30 * MIN), c(18 * MIN, 9 * MIN, 25 * MIN), c(31 * MIN, 20 * MIN, 40 * MIN), c(12 * MIN, 8 * MIN, 20 * MIN, true)));
  assert.deepEqual(x.restarts.cells, cells(c(2, 1, 3), c(1, 0, 2, true), c(4, 3, 5), c(2, 1, 3)));
  assert.deepEqual(x.diff.cells, cells({ insertions: 4120, deletions: 610, files: 38 }, { insertions: 3480, deletions: 540, files: 33 }, { insertions: 3900, deletions: 700, files: 36 }, { insertions: 3610, deletions: 590, files: 34 }));
  // The screen bolds both 3/3: a tie for the best marks no cell
  assert.deepEqual(x.tests.cells, cells({ passed: 3, total: 3 }, { passed: 3, total: 3 }, { passed: 1, total: 3 }, { passed: 2, total: 3 }));
});

test("with in, the clicks and the five judge rows are the screen's; a tie on the best (fidelity, code, spec and plan, tests) marks no cell (#476)", () => {
  const report = aggregate(fixture(), 'in', NOW);
  assert.deepEqual(report.clicks.row.cells, cells({ passed: 16, total: 18 }, { passed: 17, total: 18, best: true }, { passed: 11, total: 18 }, { passed: 15, total: 18 }));
  assert.deepEqual(report.judgeRows.map((r) => r.key), DIMENSIONS);
  const [fidelity, behavior, code, specPlan, tests] = report.judgeRows.map((r) => r.cells);
  assert.deepEqual(fidelity, cells(c(4, 4, 5), c(4, 4, 5), c(3, 3, 4), c(4, 3, 4)));
  assert.deepEqual(behavior, cells(c(4, 3, 4), c(5, 4, 5, true), c(3, 2, 4), c(4, 3, 5)));
  assert.deepEqual(code, cells(c(4, 4, 4), c(4, 4, 4), c(4, 3, 4), c(4, 4, 4)));
  // The screen bolds B's 4 on spec and plan; C's median is 4 too, so the rules mark none
  assert.deepEqual(specPlan, cells(c(3, 3, 4), c(4, 4, 5), c(4, 4, 4), c(3, 2, 3)));
  assert.deepEqual(tests, cells(c(4, 4, 4), c(4, 4, 4), c(3, 2, 3), c(3, 3, 4)));
});

test('with out, B and C enter 2 runs each: their medians move, C keeps one timeout, and B alone now takes spec and plan (#476)', () => {
  const report = aggregate(fixture(), 'out', NOW);
  assert.deepEqual(report.arms.map((a) => [a.letter, a.runs, a.inMedian, a.out]), [['A', 3, 3, 0], ['B', 3, 2, 1], ['C', 3, 2, 1], ['D', 3, 3, 0]]);
  assert.deepEqual(report.intervened.map((r) => r.inMedian), [false, false]);
  assert.deepEqual(report.execution.tokens.cells['arm-b'], c(2_450_000, 2_200_000, 2_700_000, false, 2));
  assert.deepEqual(report.execution.time.cells['arm-c'], { ...c(350 * MIN, 340 * MIN, 360 * MIN, false, 2), timeouts: 1 });
  assert.deepEqual(report.judgeRows[3].cells['arm-b'], c(4.5, 4, 5, true, 2));
  assert.deepEqual(report.clicks.row.cells['arm-b'], { passed: 11, total: 12, best: true });
});

test("a run's inMedian overrides the filter: true enters under out, false stays out under in (#476)", () => {
  const kept = aggregate(withRun(fixture(), '7d03b2', { inMedian: true }), 'out', NOW);
  assert.deepEqual([kept.arms[1].inMedian, kept.arms[1].out], [3, 0]);
  assert.deepEqual(kept.intervened, [{ token: '7d03b2', letter: 'B', inMedian: true }, { token: 'e30b71', letter: 'C', inMedian: false }]);
  assert.equal(kept.execution.tokens.cells['arm-b'].value?.median, 2_500_000);
  const dropped = aggregate(withRun(fixture(), 'aaaa03', { inMedian: false }), 'in', NOW);
  assert.deepEqual([dropped.arms[0].inMedian, dropped.arms[0].out], [2, 1]);
  assert.deepEqual(dropped.execution.tokens.cells['arm-a'], c(2_950_000, 2_800_000, 3_100_000, false, 2));
});

test("A alone in round 3: with B, C and D's round-3 runs interrupted, A's enters as a3 under either filter and the rounds stay 3 (#476)", () => {
  const cut = ['bbbb03', 'cccc03', 'dddd03'].reduce((e, token) => withRun(e, token, { status: 'interrupted' }), fixture());
  for (const filter of ['in', 'out'] as const) assert.deepEqual(aggregate(cut, filter, NOW).unpaired, ['a3'], filter);
  const report = aggregate(cut, 'in', NOW);
  assert.deepEqual([report.rounds, report.arms.map((a) => a.runs)], [3, [3, 2, 2, 2]]);
});

test('an error run adds nothing; a done run with no metrics and no evaluation counts in its column and in no row (#476)', () => {
  const base = aggregate(fixture(), 'in', NOW);
  const added = (extra: BenchRun): Experiment => {
    const e = fixture();
    return { ...e, rounds: e.rounds.map((r) => (r.n === 1 ? { ...r, runs: [...r.runs, extra] } : r)) };
  };
  const broken = benchRun(['zzzz01', 'arm-a', 1, 'done', 9_000_000, 99, 600, 90, 9, [1, 1, 1], false, 0, [1, 1, 1, 1, 1]]);
  assert.deepEqual(aggregate(added({ ...broken, status: 'error' }), 'in', NOW), base);
  const bare = aggregate(added(run('zzzz02', { armId: 'arm-d', round: 1, status: 'done' })), 'in', NOW);
  assert.deepEqual([bare.execution, bare.clicks, bare.judgeRows], [base.execution, base.clicks, base.judgeRows]);
  assert.deepEqual([bare.arms[3].runs, bare.arms[3].inMedian], [4, 4]);
});

test('sleeps group by round: an open one counts until now and a repeated reason shows once; two rubric hashes set mixedRubrics (#476)', () => {
  const sleeps = [
    { round: 2, at: '2026-10-21T23:00:00.000Z', wokeAt: '2026-10-22T01:05:00.000Z', reason: 'night' },
    { round: 3, at: '2026-10-22T07:00:00.000Z', wokeAt: '2026-10-22T07:30:00.000Z', reason: 'meeting' },
    { round: 3, at: '2026-10-22T08:00:00.000Z', wokeAt: '2026-10-22T08:10:00.000Z', reason: 'night' },
    { round: 3, at: '2026-10-22T08:40:00.000Z', reason: 'meeting' },
  ];
  assert.deepEqual(aggregate({ ...fixture(), sleeps }, 'in', NOW).sleeps, [
    { round: 2, times: 1, ms: 125 * MIN, reasons: ['night'] }, { round: 3, times: 3, ms: 60 * MIN, reasons: ['meeting', 'night'] },
  ]);
  const d1 = benchRun(ROWS.find((row) => row[0] === 'dddd01')!);
  const evaluation = { ...d1.evaluation!, judge: { ...d1.evaluation!.judge, rubricHash: 'q'.repeat(64) } };
  assert.equal(aggregate(withRun(fixture(), 'dddd01', { evaluation }), 'in', NOW).mixedRubrics, true);
});

test('aggregate leaves a deep-frozen experiment as it was (#476)', () => {
  const frozen = deepFreeze(fixture());
  const before = JSON.stringify(frozen);
  for (const filter of ['in', 'out'] as const) aggregate(frozen, filter, NOW);
  assert.equal(JSON.stringify(frozen), before);
});
