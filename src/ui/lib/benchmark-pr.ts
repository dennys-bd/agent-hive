// The PR dialog's own reading of an experiment (#477): the picker's groups and labels, the run it opens on, and the line a problem shows.
import { bestRun, endedRuns } from '../../benchmark/pr-pick.js';
import type { Arm, BenchRun, BenchRunStatus, Experiment } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import type { PrProblem } from './benchmark-pr-api.js';

export const TOKEN_SHOWN = 6; // the screens show a token's first six characters (the PR picker, the report's intervention line, the sleep dialog's pills)
const STATUS_KEY: Partial<Record<BenchRunStatus, MessageKey>> = {
  timeout: 'benchmark.pr.status.timeout', error: 'benchmark.pr.status.error', interrupted: 'benchmark.pr.status.interrupted',
};

export interface ArmRuns { arm: Arm; runs: BenchRun[] }

/** The picker's groups: every ended run under its arm, in the experiment's arm order; an arm with none is left out. */
export function runGroups(experiment: Experiment): ArmRuns[] {
  const ended = endedRuns(experiment);
  return experiment.arms.map((arm) => ({ arm, runs: ended.filter((r) => r.armId === arm.id) })).filter((group) => group.runs.length > 0);
}

/** One option: the pair, the token's prefix, delivered/total, then `melhor nota` on the best run and the status of a run not done. */
export function runLabel(run: BenchRun, best: BenchRun | undefined): string {
  const status = STATUS_KEY[run.status];
  return [
    t('benchmark.pr.option', { round: run.round, token: run.token.slice(0, TOKEN_SHOWN), delivered: run.delivered, total: run.total }),
    ...(run.token === best?.token ? [t('benchmark.pr.best')] : []),
    ...(status === undefined ? [] : [t(status)]),
  ].join(' · ');
}

/** The run the dialog opens on: the one asked for (the result screen's) when it ended, else the best-scored (the report's). */
export const initialRun = (experiment: Experiment, token: string | undefined): BenchRun | undefined =>
  endedRuns(experiment).find((r) => r.token === token) ?? bestRun(experiment);

/** The line under the body for a problem shown nowhere else; a conflict, a dirty checkout and the branch's problems sit beside their field. */
export function problemText(problem: PrProblem | undefined): string | undefined {
  switch (problem?.error) {
    case 'failed': return t(`benchmark.pr.failed.${problem.step}`);
    case 'busy': return t('benchmark.pr.busy');
    case 'no-commits': return t('benchmark.pr.noCommits');
    case 'not-ended': return t('benchmark.pr.notEnded');
    default: return undefined;
  }
}
