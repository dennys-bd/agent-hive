import { parseArgs } from 'node:util';
import { parseRunTimeout, untilDeadline } from '../../src/benchmark/deadline.js';
import { requireExperimentId } from './plan.js';

export const DEFAULT_RUNS = 3; // pairs
export const DEFAULT_RUN_TIMEOUT = '20h'; // eight deliveries, three at a time (the user, #105); the Hive's timeout grammar stops at 24h
export const DEFAULT_JUDGE_MODEL = 'claude-fable-5-1'; // the user: the judge runs once per run, so a top model costs little and reads diffs better
export const DEFAULT_BASELINE = 'origin/main';

const POSITIVE = /^[1-9]\d*$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // reaches claude's argv: never a leading -
const RUN_ID = /^[ab][1-9]\d*$/;

export interface ExperimentOptions { experiment?: string; runs?: number; until?: string; runTimeoutMs: number; judgeModel: string; baseline?: string }
export interface EvaluateOptions { experiment: string; run?: string; judgeModel: string }

function requireModel(model: string): string {
  if (!MODEL.test(model)) throw new Error(`--judge-model must be a model name: ${model}`);
  return model;
}

function requireUntil(until: string): string {
  untilDeadline(new Date(), until); // checked before anything is touched; main computes it again
  return until;
}

export function parseExperimentArgs(argv: string[]): ExperimentOptions {
  const { values } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: { experiment: { type: 'string' }, runs: { type: 'string' }, until: { type: 'string' }, 'run-timeout': { type: 'string' }, 'judge-model': { type: 'string' }, baseline: { type: 'string' } },
  });
  if (values.runs !== undefined && !POSITIVE.test(values.runs)) throw new Error(`--runs must be a positive integer: ${values.runs}`);
  return {
    ...(values.experiment === undefined ? {} : { experiment: requireExperimentId(values.experiment) }),
    ...(values.runs === undefined ? {} : { runs: Number(values.runs) }),
    ...(values.until === undefined ? {} : { until: requireUntil(values.until) }),
    ...(values.baseline === undefined ? {} : { baseline: values.baseline }),
    runTimeoutMs: parseRunTimeout(values['run-timeout'] ?? DEFAULT_RUN_TIMEOUT),
    judgeModel: requireModel(values['judge-model'] ?? DEFAULT_JUDGE_MODEL),
  };
}

export function parseEvaluateArgs(argv: string[]): EvaluateOptions {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { experiment: { type: 'string' }, run: { type: 'string' }, 'judge-model': { type: 'string' } } });
  if (values.experiment === undefined) throw new Error('--experiment is required');
  if (values.run !== undefined && !RUN_ID.test(values.run)) throw new Error(`--run must be a run id like a1 or b2: ${values.run}`);
  return { experiment: requireExperimentId(values.experiment), ...(values.run === undefined ? {} : { run: values.run }), judgeModel: requireModel(values['judge-model'] ?? DEFAULT_JUDGE_MODEL) };
}
