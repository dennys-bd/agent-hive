// report.md (#476): the aggregate as markdown, in English, and the only file that maps a run's token to its arm; blindness keeps that
// mapping out of everything a worker or the judge reads. Written whole each time, so a reader never meets a partial file.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Experiment } from '../types.js';
import { aggregate, type BenchReport, type DiffCell, type RatioCell, type ReportRow, type SpreadCell } from './report.js';

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const MILLION = 1_000_000;
const HASH_SHOWN = 6; // the screens show a hash's first six characters
const NO_VALUE = '-';
type Format = (value: number) => string;

// A median of two may be a half; more than two decimals is noise in a table
const plain: Format = (value) => String(Number(value.toFixed(2)));
const millions: Format = (value) => `${(value / MILLION).toFixed(1)}M`;
const usd: Format = (value) => `$${plain(value)}`;
function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  const hours = Math.floor(minutes / HOUR_MINUTES);
  return hours === 0 ? `${minutes}m` : `${hours}h${String(minutes % HOUR_MINUTES).padStart(2, '0')}`;
}

// A name or a criterion is the user's text: a pipe in it would split the table's cell
const escaped = (text: string): string => text.replaceAll('|', '\\|');
const bold = (text: string, best: true | undefined): string => (best ? `**${text}**` : text);

function spreadText(cell: SpreadCell, format: Format): string {
  if (cell.value === undefined) return NO_VALUE;
  const { median, min, max } = cell.value;
  const range = cell.timeouts === undefined ? `${format(min)}–${format(max)}` : `timeout ×${cell.timeouts}`;
  return `${bold(format(median), cell.best)} (${range})`;
}
const ratioText = (cell: RatioCell): string => bold(`${cell.passed}/${cell.total}`, cell.best);
const diffText = (cell: DiffCell | undefined): string =>
  (cell === undefined ? NO_VALUE : `+${plain(cell.insertions)} −${plain(cell.deletions)}, ${plain(cell.files)} files`);

function line<C>(report: BenchReport, label: string, row: ReportRow<C>, text: (cell: C) => string): string {
  return `| ${escaped(label)} | ${report.arms.map((a) => text(row.cells[a.armId])).join(' | ')} |`;
}

function head(report: BenchReport, section: string): string[] {
  const arms = report.arms.map((a) => `${a.letter} · ${escaped(a.name)}${a.onlyPerRun ? ' (only per run)' : ''}`);
  return [`| ${section} | ${arms.join(' | ')} |`, `|${' --- |'.repeat(arms.length + 1)}`];
}

function tables(report: BenchReport): string[] {
  const x = report.execution;
  const { first, last } = report.clicks;
  const scenarios = first === undefined || last === undefined ? 'scenarios' : `${first} · ${last}`;
  return [
    ...head(report, 'execution'),
    line(report, 'tokens', x.tokens, (cell) => spreadText(cell, millions)), line(report, 'cost', x.cost, (cell) => spreadText(cell, usd)),
    line(report, 'time', x.time, (cell) => spreadText(cell, duration)), line(report, 'waiting', x.waiting, (cell) => spreadText(cell, duration)),
    line(report, 'build restarts', x.restarts, (cell) => spreadText(cell, plain)), line(report, 'diff', x.diff, diffText),
    line(report, 'tests green', x.tests, ratioText),
    '', ...head(report, 'click scenarios'), line(report, scenarios, report.clicks.row, ratioText),
    '', ...head(report, 'judge'), ...report.judgeRows.map((row) => line(report, row.key, row, (cell) => spreadText(cell, plain))),
  ];
}

function headLines(experiment: Experiment, report: BenchReport): string[] {
  const { agent, model } = report.judge;
  const judge = model === undefined ? agent : `${agent} · ${model}`;
  const notes = [
    `experiment ${experiment.id}`, `seed ${experiment.seedHash.slice(0, HASH_SHOWN)}`, `plugin ${experiment.plugin.hash.slice(0, HASH_SHOWN)}`,
    `${report.rounds} rounds`, `judged by ${judge}`,
    ...(report.unpaired.length === 0 ? [] : [`unpaired: ${report.unpaired.join(', ')}`]),
    ...(report.mixedRubrics ? ['judged by more than one rubric'] : []),
  ];
  return [`# ${experiment.name}`, '', notes.join(' · ')];
}

// The one place a token meets its arm: every run of the arm, eligible or not
function armLines(experiment: Experiment): string[] {
  const runs = experiment.rounds.flatMap((r) => r.runs);
  return experiment.arms.map((arm) => `- ${arm.letter} · ${arm.name}: ${runs.filter((r) => r.armId === arm.id).map((r) => r.token).join(', ')}`);
}

function noteLines(report: BenchReport): string[] {
  const runs = report.intervened.map((r) => `${r.letter} ${r.token} (${r.inMedian ? 'in the median' : 'left out'})`);
  const filter = report.filter === 'in' ? 'enter the median' : 'left out';
  const interventions = runs.length === 0 ? [] : [`Runs with interventions (${filter}, per-run overrides applied): ${runs.join(', ')}`];
  return [...interventions, ...report.sleeps.map((s) => `Round ${s.round} slept ${s.times}× for ${duration(s.ms)} (${s.reasons.join('; ')}).`)];
}

/** The report as markdown (#476): the head line, the arms with their tokens, the intervention and sleep lines, one table per section. */
export function renderReport(experiment: Experiment, report: BenchReport): string {
  return [...headLines(experiment, report), '', ...armLines(experiment), '', ...noteLines(report), '', ...tables(report), ''].join('\n');
}

/** <dir>/report.md with the filter in (#476): the route writes it on demand, 3.2 after a round's evaluation, 3.4 after a re-evaluation. */
export async function writeReport(dir: string, experiment: Experiment, now: number): Promise<void> {
  await writeFile(join(dir, 'report.md'), renderReport(experiment, aggregate(experiment, 'in', now)));
}
