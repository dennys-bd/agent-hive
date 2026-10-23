// The result screen's pure parts (#466): what each block shows of a run, so they are tested without rendering. The arm medians are the
// report's (#476) under its default filter, computed here from the live state with no fetch.
import { duration, millions, usd } from '../../../../benchmark/format.js';
import { aggregate } from '../../../../benchmark/report.js';
import type { BenchMetrics, BenchRun, BenchRunStatus, CollectorResult, Experiment, ScenarioResult } from '../../../../types.js';
import { formatCount, type MessageKey, t, tPlural } from '@/i18n';
import { clockOf } from '@/lib/design-comments';

export type Tone = 'green' | 'yellow' | 'red' | 'muted';
/** Colour only for status (design-system): the dots and the chips. */
export const TONE_CLASS: Record<Tone, string> = { green: 'text-working', yellow: 'text-waiting', red: 'text-destructive', muted: 'text-muted-foreground' };
export interface MetricCell { label: string; value: string; context: string[] }
export interface ScenarioTotals { passed: number; total: number; walks: number; firstFailure?: { id: string; failed: number } }

const NO_VALUE = '—';
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

export const runOf = (experiment: Experiment, token: string | undefined): BenchRun | undefined =>
  (token === undefined ? undefined : experiment.rounds.flatMap((r) => r.runs).find((r) => r.token === token));

export function armMedians(experiment: Experiment, armId: string, now: number): { tokens?: number; costUsd?: number } {
  const { tokens, cost } = aggregate(experiment, 'in', now).execution;
  return { tokens: tokens.cells[armId]?.value?.median, costUsd: cost.cells[armId]?.value?.median };
}

export function scenarioTotals(scenarios: readonly ScenarioResult[]): ScenarioTotals {
  const failing = scenarios.find((s) => s.passed < s.total);
  return {
    passed: sum(scenarios.map((s) => s.passed)), total: sum(scenarios.map((s) => s.total)), walks: Math.max(0, ...scenarios.map((s) => s.total)),
    ...(failing === undefined ? {} : { firstFailure: { id: failing.id, failed: failing.total - failing.passed } }),
  };
}
// The design draws no red for scenarios
export const scenarioTone = (s: ScenarioResult): Tone => (s.passed === s.total ? 'green' : 'yellow');
// The last screenshot is the scenario's final state
export const lastShot = (s: ScenarioResult): string | undefined => s.screenshots.at(-1);
export const screenUrl = (experimentId: string, token: string, name: string): string =>
  `/benchmark/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(token)}/screens/${encodeURIComponent(name)}`;

const COLLECTOR_TONE: Record<CollectorResult['status'], Tone> = { ok: 'green', warn: 'yellow', error: 'red' };
export function collectorView(c: CollectorResult): { tone: Tone; text: string; summary: string } {
  const text = c.status === 'warn'
    ? tPlural('benchmark.result.findings', c.findings.length, { n: c.findings.length })
    : t(c.status === 'ok' ? 'benchmark.result.collector.ok' : 'benchmark.result.collector.error');
  return { tone: COLLECTOR_TONE[c.status], text, summary: c.summary.trim() === '' ? NO_VALUE : c.summary };
}

// BenchMetrics has no approval count (node 3.3's contract): the line counts the tasks that waited
export const waitingTasks = (metrics: BenchMetrics): number => metrics.tasks.filter((task) => task.waitingMs > 0).length;
// Sleeps are recorded per round, not per run
export const sleepsInRound = (experiment: Experiment, round: number): number => experiment.sleeps.filter((s) => s.round === round).length;

const STATUS: Record<BenchRunStatus, { key: MessageKey; tone: Tone }> = {
  queued: { key: 'benchmark.result.status.queued', tone: 'muted' }, running: { key: 'benchmark.result.status.running', tone: 'green' },
  waiting: { key: 'benchmark.result.status.waiting', tone: 'yellow' }, sleeping: { key: 'benchmark.result.status.sleeping', tone: 'muted' },
  done: { key: 'benchmark.result.status.done', tone: 'muted' }, timeout: { key: 'benchmark.result.status.timeout', tone: 'yellow' },
  error: { key: 'benchmark.result.status.error', tone: 'red' }, interrupted: { key: 'benchmark.result.status.interrupted', tone: 'muted' },
};
export function runChip(run: BenchRun): { tone: Tone; text: string } {
  const { key, tone } = STATUS[run.status];
  const { startedAt, endedAt } = run;
  if (run.status !== 'done' || startedAt === undefined || endedAt === undefined) return { tone, text: t(key) };
  return { tone, text: `${t(key)} · ${clockOf(new Date(startedAt))} → ${clockOf(new Date(endedAt))}` };
}

const cell = (key: MessageKey, value: string, context: (string | undefined)[] = []): MetricCell =>
  ({ label: t(key), value, context: context.filter((line): line is string => line !== undefined && line !== '') });
const medianLine = (letter: string, value: number | undefined, format: (n: number) => string): string | undefined =>
  (value === undefined ? undefined : t('benchmark.result.median', { letter, value: format(value) }));

function scenariosCell(run: BenchRun): MetricCell {
  if (run.evaluation === undefined) return cell('benchmark.result.metric.scenarios', NO_VALUE, [t('benchmark.result.notEvaluated')]);
  const { passed, total, firstFailure } = scenarioTotals(run.evaluation.scenarios);
  const line = firstFailure === undefined ? t('benchmark.result.allPassed') : t('benchmark.result.failedTimes', { id: firstFailure.id, n: firstFailure.failed });
  return cell('benchmark.result.metric.scenarios', `${passed}/${total}`, [line]);
}

/** The strip's eight cells (#466), or none for a run with no metrics. The UI never prices: `unpriced` is the run's own list (#473). */
export function metricCells(experiment: Experiment, run: BenchRun, now: number): MetricCell[] | undefined {
  const { metrics } = run;
  if (metrics === undefined) return undefined;
  const letter = experiment.arms.find((a) => a.id === run.armId)?.letter ?? '';
  const medians = armMedians(experiment, run.armId, now);
  const unpriced = run.unpriced !== undefined && run.unpriced.length > 0 ? t('benchmark.result.unpriced', { models: run.unpriced.join(', ') }) : undefined;
  const waiting = waitingTasks(metrics);
  const { diff, tests, restarts } = metrics;
  return [
    cell('benchmark.result.metric.tokens', millions(metrics.tokens), [medianLine(letter, medians.tokens, millions)]),
    cell('benchmark.result.metric.cost', usd(metrics.costUsd), [medianLine(letter, medians.costUsd, usd), unpriced]),
    cell('benchmark.result.metric.time', duration(metrics.ms), [t('benchmark.result.noSleep')]),
    cell('benchmark.result.metric.waiting', duration(metrics.waitingMs), [waiting === 0 ? undefined : tPlural('benchmark.result.waitingTasks', waiting, { n: waiting })]),
    cell('benchmark.result.metric.restarts', String(restarts.count), [restarts.where.join(' · ')]),
    cell('benchmark.result.metric.diff', `+${formatCount(diff.insertions)} −${formatCount(diff.deletions)}`, [tPlural('diff.files', diff.files, { n: diff.files })]),
    cell('benchmark.result.metric.tests', `${tests.green}/${tests.total}`, [t('benchmark.result.passing')]),
    scenariosCell(run),
  ];
}
