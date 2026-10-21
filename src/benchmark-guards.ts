// The load of state.benchmark (#458). A value that later reaches argv, a path or a regex (ids, tokens, home, branch, commit, workspace) and
// every enum is checked field by field; the deep config objects only by shape, since none reaches either before 1.2's routes validate them
// on write. Then the boot rule. state.json is the user's file: a hand edit must not name a folder or a branch outside the experiment's own.
import { join } from 'node:path';
import { COMMIT, isJsonObject } from './state-guards.js';
import { BENCH_RUN_STATUSES, BENCH_TOKEN, EXPERIMENT_ID, EXPERIMENT_STATUSES, isBranchName, type Arm, type BenchmarkState, type BenchRound, type BenchRun, type BenchRunStatus, type Experiment, type ExperimentStatus } from './types.js';

const STRINGS = ['name', 'createdAt', 'workspace', 'seedHash', 'tasksHash'] as const;
const OBJECTS = ['base', 'seed', 'pace', 'isolation', 'blindness', 'evaluation', 'createdBy', 'plugin'] as const;
const ARRAYS = ['arms', 'rounds', 'sleeps'] as const;
const UNFINISHED: readonly BenchRunStatus[] = ['queued', 'running', 'waiting'];

const isText = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// A run's home is booted as a Hive home and removed with the experiment (3.1, 3.5): only the folder 3.1 makes for this id and token under
// this Hive's home, compared whole so no root, `..` or separator of any platform slips through
export const runHome = (hiveDir: string, id: string, token: string): string => join(hiveDir, 'benchmark', id, 'runs', token);
// The run branch is `<neutral>/<token>` (3.1): a hand edit naming `main` or any other branch is not this run's
const isRunBranch = (branch: unknown, token: string): boolean => isText(branch) && isBranchName(branch) && branch.endsWith(`/${token}`);

function loadRun(value: unknown, id: string, hiveDir: string): BenchRun[] {
  if (!isJsonObject(value)) return [];
  const { token, status, branch, home } = value;
  if (!isText(token) || !BENCH_TOKEN.test(token) || !BENCH_RUN_STATUSES.includes(status as BenchRunStatus)) return [];
  if (!isRunBranch(branch, token) || home !== runHome(hiveDir, id, token)) return [];
  const shaped = isText(value.armId) && isNumber(value.round) && isNumber(value.sleptMs) && isNumber(value.delivered) && isNumber(value.total) && Array.isArray(value.interventions);
  return shaped ? [value as unknown as BenchRun] : [];
}

function loadRound(value: unknown, id: string, hiveDir: string): BenchRound[] {
  if (!isJsonObject(value) || !isNumber(value.n) || !Number.isInteger(value.n) || value.n < 1 || !Array.isArray(value.runs)) return [];
  return [{ ...(value as unknown as BenchRound), runs: value.runs.flatMap((run) => loadRun(run, id, hiveDir)) }];
}

// Two entries under one key would share a home and a branch, or a perArm slot: the first one is kept
const firstBy = <T>(items: T[], key: (item: T) => string): T[] => items.filter((item, i) => items.findIndex((other) => key(other) === key(item)) === i);
const uniqueTokens = (rounds: BenchRound[]): BenchRound[] => {
  const all = rounds.flatMap((round) => round.runs);
  return rounds.map((round) => ({ ...round, runs: round.runs.filter((run) => all.find((other) => other.token === run.token) === run) }));
};

// An arm id keys the isolation rows' perArm and may name a folder: the experiment id's shape, so no `__proto__` or `constructor` either
const isArm = (value: unknown): value is Arm => isJsonObject(value) && isText(value.id) && EXPERIMENT_ID.test(value.id) && isText(value.letter);
const isSeedCommit = (seed: unknown): boolean => isJsonObject(seed) && isText(seed.commit) && COMMIT.test(seed.commit);

function isExperimentHead(value: unknown): value is Record<string, unknown> & { id: string; arms: unknown[]; rounds: unknown[] } {
  if (!isJsonObject(value) || !isText(value.id) || !EXPERIMENT_ID.test(value.id)) return false;
  if (!EXPERIMENT_STATUSES.includes(value.status as ExperimentStatus) || !isSeedCommit(value.seed)) return false;
  return STRINGS.every((k) => isText(value[k])) && OBJECTS.every((k) => isJsonObject(value[k])) && ARRAYS.every((k) => Array.isArray(value[k]));
}

function interrupted(run: BenchRun): BenchRun {
  if (!UNFINISHED.includes(run.status)) return run;
  const { endedAt: _endedAt, ...rest } = run;
  return { ...rest, status: 'interrupted' };
}

// A running experiment's daemons died with the Hive: it boots done with its unfinished runs interrupted, and executar reruns them with new
// tokens. A sleeping one stays sleeping: waking it is 3.2's, which treats a run whose daemon is gone as interrupted
function booted(experiment: Experiment): Experiment {
  if (experiment.status !== 'running') return experiment;
  const { stopAfterRound: _stop, ...rest } = experiment;
  return { ...rest, status: 'done', rounds: rest.rounds.map((round) => ({ ...round, runs: round.runs.map(interrupted) })) };
}

function loadExperiment(value: unknown, hiveDir: string): Experiment[] {
  if (!isExperimentHead(value)) return [];
  const rounds = uniqueTokens(value.rounds.flatMap((round) => loadRound(round, value.id, hiveDir)));
  return [booted({ ...value, arms: firstBy(value.arms.filter(isArm), (a) => a.id), rounds } as unknown as Experiment)];
}

/** state.benchmark as state.json under hiveDir held it (#458); a missing or malformed key reads as no experiment. Duplicate ids keep the first. */
export function loadBenchmark(raw: unknown, hiveDir: string): BenchmarkState {
  if (!isJsonObject(raw) || !Array.isArray(raw.experiments)) return { experiments: [] };
  return { experiments: firstBy(raw.experiments.flatMap((e) => loadExperiment(e, hiveDir)), (e) => e.id) };
}
