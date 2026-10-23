// The report of an experiment (#476): medians and ranges per arm and metric over the runs that enter, the row's best, the intervention
// filter and its per-run override, the sleeps and the unpaired runs. A route's answer, not state, so its types live here and the UI imports
// them from here. New code, not the retired #105 harness's Manifest report, which shared nothing with Experiment. Pure, no I/O.
import type { AgentId, Arm, BenchMetrics, BenchRun, BenchRunStatus, Experiment } from '../types.js';
import { bestOf, type Spread, spread } from './median.js';

export type { Spread } from './median.js';
export type ReportFilter = 'in' | 'out';
export interface ArmColumn {
  armId: string; letter: string; name: string;
  runs: number;          // eligible runs
  inMedian: number;      // runs that entered under the filter and overrides
  intervened: number;    // eligible runs with at least one intervention
  out: number;           // eligible runs left out (filter or override)
  slept: number;         // eligible runs with sleptMs > 0
  onlyPerRun: boolean;   // the arm's tasks differ from the base's
}
export interface SpreadCell { value?: Spread; best?: true; timeouts?: number }
export interface DiffCell { insertions: number; deletions: number; files: number } // medians
export interface RatioCell { passed: number; total: number; best?: true }
export interface ReportRow<C> { key: string; cells: Record<string, C> } // keyed by arm id
export interface BenchReport {
  experimentId: string; filter: ReportFilter; rounds: number;
  unpaired: string[];                                   // ['a3']
  judge: { agent: AgentId; model?: string }; mixedRubrics: boolean;
  intervened: { token: string; letter: string; inMedian: boolean }[];
  sleeps: { round: number; times: number; ms: number; reasons: string[] }[];
  arms: ArmColumn[];
  execution: {
    tokens: ReportRow<SpreadCell>; cost: ReportRow<SpreadCell>; time: ReportRow<SpreadCell>;
    waiting: ReportRow<SpreadCell>; restarts: ReportRow<SpreadCell>;
    diff: ReportRow<DiffCell | undefined>; tests: ReportRow<RatioCell>;
  };
  clicks: { first?: string; last?: string; row: ReportRow<RatioCell> };
  judgeRows: ReportRow<SpreadCell>[];                    // one per criterion, keyed by dimension
}

type Direction = 'low' | 'high';
type ByArm = Record<string, BenchRun[]>;
type Count = Omit<RatioCell, 'best'>;

// A timed-out run is a real result, its time the cut; a broken or unfinished one is not
const ELIGIBLE: readonly BenchRunStatus[] = ['done', 'timeout'];

const mapValues = <T, U>(record: Record<string, T>, change: (value: T, key: string) => U): Record<string, U> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, change(value, key)]));
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const defined = (values: (number | undefined)[]): number[] => values.filter((value): value is number => value !== undefined);
const marked = <C extends object>(cell: C, isBest: boolean): C => (isBest ? { ...cell, best: true as const } : cell);

// The filter applies to runs with interventions; a run's own inMedian overrides it either way
const enters = (run: BenchRun, filter: ReportFilter): boolean => run.inMedian ?? (filter === 'in' || run.interventions.length === 0);
const isEligible = (experiment: Experiment) => (run: BenchRun): boolean =>
  ELIGIBLE.includes(run.status) && experiment.arms.some((a) => a.id === run.armId);
const letterOf = (experiment: Experiment, armId: string): string => experiment.arms.find((a) => a.id === armId)?.letter ?? '';

// A metric a run lacks is skipped for that run, never read as 0
function spreadRow(key: string, byArm: ByArm, pick: (run: BenchRun) => number | undefined, direction: Direction): ReportRow<SpreadCell> {
  const spreads = mapValues(byArm, (runs) => spread(defined(runs.map(pick))));
  const best = bestOf(mapValues(spreads, (s) => s?.median), direction);
  return { key, cells: mapValues(spreads, (value, armId): SpreadCell => marked(value === undefined ? {} : { value }, armId === best)) };
}

const fromMetrics = (read: (metrics: BenchMetrics) => number) => (run: BenchRun): number | undefined =>
  (run.metrics === undefined ? undefined : read(run.metrics));

// 2.7 shows timeout ×N in place of the range: a timed-out run's time is the cut, not a measure
function withTimeouts(row: ReportRow<SpreadCell>, byArm: ByArm): ReportRow<SpreadCell> {
  const cells = mapValues(row.cells, (cell, armId) => {
    const timeouts = byArm[armId].filter((r) => r.status === 'timeout').length;
    return timeouts === 0 ? cell : { ...cell, timeouts };
  });
  return { ...row, cells };
}

function diffCell(runs: BenchRun[]): DiffCell | undefined {
  const diffs = runs.flatMap((r) => (r.metrics === undefined ? [] : [r.metrics.diff]));
  const median = (read: (diff: BenchMetrics['diff']) => number): number => spread(diffs.map(read))?.median ?? 0;
  return diffs.length === 0 ? undefined : { insertions: median((d) => d.insertions), deletions: median((d) => d.deletions), files: median((d) => d.files) };
}

// An arm with no total takes no part: 0/0 is no ratio
function ratioRow(key: string, counts: Record<string, Count>): ReportRow<RatioCell> {
  const best = bestOf(mapValues(counts, (count) => (count.total > 0 ? count.passed / count.total : undefined)), 'high');
  return { key, cells: mapValues(counts, (count, armId) => marked(count, armId === best)) };
}

function testsCount(runs: BenchRun[]): Count {
  const measured = runs.flatMap((r) => (r.metrics === undefined ? [] : [r.metrics.tests]));
  return { passed: measured.filter((t) => t.total > 0 && t.green === t.total).length, total: measured.length };
}

function clicksCount(runs: BenchRun[]): Count {
  const results = runs.flatMap((r) => r.evaluation?.scenarios ?? []);
  return { passed: sum(results.map((s) => s.passed)), total: sum(results.map((s) => s.total)) };
}

// Lower is better on every execution row; the diff has no best, more or fewer lines is not better by itself
function execution(byArm: ByArm): BenchReport['execution'] {
  const low = (key: string, read: (metrics: BenchMetrics) => number) => spreadRow(key, byArm, fromMetrics(read), 'low');
  return {
    tokens: low('tokens', (m) => m.tokens), cost: low('cost', (m) => m.costUsd), time: withTimeouts(low('time', (m) => m.ms), byArm),
    waiting: low('waiting', (m) => m.waitingMs), restarts: low('restarts', (m) => m.restarts.count),
    diff: { key: 'diff', cells: mapValues(byArm, diffCell) }, tests: ratioRow('tests', mapValues(byArm, testsCount)),
  };
}

// One row per criterion, in the order the runs first name it; a run judged without it is skipped on that row
function judgeRows(entering: BenchRun[], byArm: ByArm): ReportRow<SpreadCell>[] {
  const dimensions = [...new Set(entering.flatMap((r) => r.evaluation?.judge.scores.map((s) => s.dimension) ?? []))];
  return dimensions.map((dimension) =>
    spreadRow(dimension, byArm, (r) => r.evaluation?.judge.scores.find((s) => s.dimension === dimension)?.score, 'high'));
}

// Compared as JSON: an arm that only restates the base's tasks still runs the same problem
const onlyPerRun = (arm: Arm, experiment: Experiment): boolean =>
  arm.overrides.tasks !== undefined && JSON.stringify(arm.overrides.tasks) !== JSON.stringify(experiment.base.tasks);

function column(arm: Arm, experiment: Experiment, eligible: BenchRun[], filter: ReportFilter): ArmColumn {
  const own = eligible.filter((r) => r.armId === arm.id);
  const inMedian = own.filter((r) => enters(r, filter)).length;
  return {
    armId: arm.id, letter: arm.letter, name: arm.name, runs: own.length, inMedian, out: own.length - inMedian,
    intervened: own.filter((r) => r.interventions.length > 0).length, slept: own.filter((r) => r.sleptMs > 0).length,
    onlyPerRun: onlyPerRun(arm, experiment),
  };
}

// A run that entered while some other arm of its round has no eligible run ran alone (the harness's "unpaired"), labelled as the screen's a3
function unpaired(experiment: Experiment, filter: ReportFilter): string[] {
  const eligible = isEligible(experiment);
  return experiment.rounds.flatMap((round) => {
    const ran = round.runs.filter(eligible);
    if (experiment.arms.every((a) => ran.some((r) => r.armId === a.id))) return [];
    return ran.filter((r) => enters(r, filter)).map((r) => `${letterOf(experiment, r.armId).toLowerCase()}${round.n}`);
  });
}

// Sleep never excludes a run (metrics.ms already has slept time removed, 3.3): the report only describes it. An open sleep counts until now
function sleepLines(experiment: Experiment, now: number): BenchReport['sleeps'] {
  const rounds = [...new Set(experiment.sleeps.map((s) => s.round))];
  return rounds.map((round) => {
    const own = experiment.sleeps.filter((s) => s.round === round);
    const ms = sum(own.map((s) => (s.wokeAt === undefined ? now : Date.parse(s.wokeAt)) - Date.parse(s.at)));
    return { round, times: own.length, ms, reasons: [...new Set(own.map((s) => s.reason))] };
  });
}

/** The report of an experiment under the intervention filter (#476); `now` closes an open sleep. Every row reads only the runs that enter. */
export function aggregate(experiment: Experiment, filter: ReportFilter, now: number): BenchReport {
  const eligible = experiment.rounds.flatMap((r) => r.runs).filter(isEligible(experiment));
  const entering = eligible.filter((r) => enters(r, filter));
  const byArm: ByArm = Object.fromEntries(experiment.arms.map((a) => [a.id, entering.filter((r) => r.armId === a.id)]));
  const { agent, model } = experiment.evaluation.judge;
  const first = experiment.seed.scenarios.at(0)?.id;
  const last = experiment.seed.scenarios.at(-1)?.id;
  return {
    experimentId: experiment.id, filter, rounds: experiment.rounds.filter((r) => r.runs.some(isEligible(experiment))).length,
    unpaired: unpaired(experiment, filter), judge: model === undefined ? { agent } : { agent, model },
    mixedRubrics: new Set(entering.flatMap((r) => (r.evaluation === undefined ? [] : [r.evaluation.judge.rubricHash]))).size > 1,
    intervened: eligible.filter((r) => r.interventions.length > 0)
      .map((r) => ({ token: r.token, letter: letterOf(experiment, r.armId), inMedian: enters(r, filter) })),
    sleeps: sleepLines(experiment, now),
    arms: experiment.arms.map((a) => column(a, experiment, eligible, filter)),
    execution: execution(byArm),
    clicks: { ...(first === undefined ? {} : { first }), ...(last === undefined ? {} : { last }), row: ratioRow('clicks', mapValues(byArm, clicksCount)) },
    judgeRows: judgeRows(entering, byArm),
  };
}

// What POST …/evaluate takes (#474); here, beside the report and free of Node, so the report tab's confirmation counts the same runs (#467)
const EVALUABLE: readonly BenchRunStatus[] = ['done', 'timeout', 'error'];

/** The runs the experiment route evaluates (#474): every done, timeout or error run, in round then arm order. */
export function evaluableTokens(experiment: Experiment): string[] {
  const armIndex = (armId: string): number => experiment.arms.findIndex((a) => a.id === armId);
  return [...experiment.rounds].sort((a, b) => a.n - b.n)
    .flatMap((round) => round.runs.filter((r) => EVALUABLE.includes(r.status)).sort((a, b) => armIndex(a.armId) - armIndex(b.armId)))
    .map((r) => r.token);
}
