// What the benchmark PR dialog and its routes share (#477): the routes' answers, which runs can open a PR, the best-scored one, and the
// branch and title suggested from the experiment's name. Pure and free of Node: the dialog imports it as the server does; pr.ts re-exports the types.
import type { BenchmarkPrIn, BenchRun, BenchRunStatus, Experiment } from '../types.js';

export interface BenchPrPreview {
  token: string; armId: string; status: BenchRunStatus;
  commits: number; tasks: number;   // commits after the baseline; run.total
  base: string; baseSha: string;    // origin/<baseBranch>, its short sha
  branch: string; title: string;    // the suggestions
  via: BenchmarkPrIn;
}
export type BenchPrAnswer = { url: string };
export type BenchPrRefusal =
  | { error: 'conflict'; files: string[] } | { error: 'dirty'; files: string[] }
  | { error: 'branch-exists' } | { error: 'no-commits' } | { error: 'not-ended' } | { error: 'busy' };
/** The steps a 502 names (#477), each one a `benchmark.pr.failed.<step>` line of the dialog. */
export const BENCH_PR_STEPS = ['fetch', 'branch', 'rebase', 'files', 'push', 'pr'] as const;
export type BenchPrStep = (typeof BENCH_PR_STEPS)[number];

// Any run that stopped can be rescued, a partial one included; a queued, running, waiting or sleeping one has no last commit yet
const ENDED: readonly BenchRunStatus[] = ['done', 'timeout', 'error', 'interrupted'];
const BRANCH_SLUG_MAX = 60;
const NO_SLUG = 'experiment';

export const isEnded = (run: BenchRun): boolean => ENDED.includes(run.status);
/** Every ended run, in round order, then in each round's run order. */
export const endedRuns = (experiment: Experiment): BenchRun[] => experiment.rounds.flatMap((round) => round.runs).filter(isEnded);

interface Judged { run: BenchRun; mean: number }

function meanOf(run: BenchRun): number | undefined {
  const scores = run.evaluation?.judge.scores ?? [];
  return scores.length === 0 ? undefined : scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
}

// A run with no metrics is ranked as the costliest: a measure it lacks never wins a tie
const tokensOf = (run: BenchRun): number => run.metrics?.tokens ?? Number.POSITIVE_INFINITY;

// The spec's ranking: the higher mean, then done before any other ended status, then fewer tokens, then the earlier round
function byRank(a: Judged, b: Judged): number {
  if (a.mean !== b.mean) return b.mean - a.mean;
  const done = Number(b.run.status === 'done') - Number(a.run.status === 'done');
  if (done !== 0) return done;
  if (tokensOf(a.run) !== tokensOf(b.run)) return tokensOf(a.run) - tokensOf(b.run);
  return a.run.round - b.run.round;
}

/** The run the dialog opens on without a token (#477): the best-scored ended run; with no judged one, the first ended; with none ended, none. */
export function bestRun(experiment: Experiment): BenchRun | undefined {
  const ended = endedRuns(experiment);
  const judged = ended.flatMap((run): Judged[] => {
    const mean = meanOf(run);
    return mean === undefined ? [] : [{ run, mean }];
  });
  return judged.length === 0 ? ended.at(0) : [...judged].sort(byRank)[0].run;
}

/** `feat/<kebab of the name>` (#477): accents dropped, anything else not a letter or digit one dash, capped so a long name stays a usable branch. */
export function suggestBranch(name: string): string {
  const slug = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, BRANCH_SLUG_MAX).replace(/-+$/, '');
  return `feat/${slug === '' ? NO_SLUG : slug}`;
}

export const prTitle = (name: string): string => `feat: ${name}`;
