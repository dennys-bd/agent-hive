// A benchmark run's PR (#477): the run branch fetched from the run's origin, rebased onto the workspace's base in a temporary worktree or the
// workspace's checkout, stripped of the run's own files, pushed and opened with gh. Every command is an argv through the injected runners;
// prBody is pure. The route (server-benchmark-pr.ts) checks the request; this module answers a refusal, a URL, or a PrStepError naming its step.
import type { BenchRun, Experiment } from '../types.js';
import { mergeArm } from './arm-config.js';
import { duration, HASH_SHOWN, millions, plain, usd } from './report-md.js';
import type { BenchReport, SpreadCell } from './report.js';

export type { BenchPrAnswer, BenchPrPreview, BenchPrRefusal, BenchPrStep } from './pr-pick.js';

const BODY_LINE = 'Opened from a benchmark run.';
const NO_VALUE = '-';

const median = (cell: SpreadCell | undefined, format: (value: number) => string): string =>
  (cell?.value === undefined ? NO_VALUE : format(cell.value.median));
const hashes = (e: Experiment): string =>
  [`seed ${e.seedHash.slice(0, HASH_SHOWN)}`, `tasks ${e.tasksHash.slice(0, HASH_SHOWN)}`, `plugin ${e.plugin.hash.slice(0, HASH_SHOWN)}`].join(' · ');

// The arm's column of the report, in report.md's formats; no link, since the Hive has no URL for an experiment
function summaryLines(experiment: Experiment, run: BenchRun, report: BenchReport): string[] {
  const arm = experiment.arms.find((a) => a.id === run.armId);
  const x = report.execution;
  const tests = x.tests.cells[run.armId];
  return [
    `Experiment ${experiment.name}, arm ${arm?.letter ?? NO_VALUE} · ${arm?.name ?? NO_VALUE}, run ${run.token}, round ${run.round}.`, '',
    `- tokens: ${median(x.tokens.cells[run.armId], millions)}`, `- cost: ${median(x.cost.cells[run.armId], usd)}`,
    `- time: ${median(x.time.cells[run.armId], duration)}`, `- tests green: ${tests === undefined ? NO_VALUE : `${tests.passed}/${tests.total}`}`,
    ...report.judgeRows.map((row) => `- ${row.key}: ${median(row.cells[run.armId], plain)}`), '', hashes(experiment),
  ];
}

/** The PR's description, in English (#477): with the report, the run and its arm's column of it; without, the run's task titles. */
export function prBody(experiment: Experiment, run: BenchRun, report: BenchReport | undefined): string {
  if (report !== undefined) return [BODY_LINE, '', ...summaryLines(experiment, run, report), ''].join('\n');
  const arm = experiment.arms.find((a) => a.id === run.armId);
  const tasks = arm === undefined ? experiment.base.tasks : mergeArm(experiment.base, arm.overrides).tasks;
  return [BODY_LINE, '', ...tasks.map((task) => `- ${task.title}`), ''].join('\n');
}
