// The benchmark PR routes (#477) the dialog calls: the preview of a run, and the PR. A refusal is told apart by its status and its error, so
// the server's own words never reach the screen.
import { BENCH_PR_STEPS, type BenchPrAnswer, type BenchPrPreview, type BenchPrRefusal, type BenchPrStep } from '../../benchmark/pr-pick.js';
import { getJson, postJson } from './api.js'; // relative: the root tsc compiles this file too

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const SIMPLE_REFUSALS = ['branch-exists', 'no-commits', 'not-ended', 'busy'] as const;
type SimpleRefusal = (typeof SIMPLE_REFUSALS)[number];

/** What a refused or failed PR shows (#477): the route's refusal, a branch name it refused, or a failed step ('unknown' when none is named). */
export type PrProblem = BenchPrRefusal | { error: 'invalid-branch' } | { error: 'failed'; step: BenchPrStep | 'unknown' };

const prPath = (id: string, token: string): string => `/benchmark/experiments/${encodeURIComponent(id)}/runs/${encodeURIComponent(token)}/pr`;
export const readPrPreview = (id: string, token: string): Promise<BenchPrPreview> => getJson<BenchPrPreview>(prPath(id, token));
export const openBenchPr = (id: string, token: string, body: { branch: string; withSummary: boolean }): Promise<BenchPrAnswer> =>
  postJson<BenchPrAnswer>(prPath(id, token), body);

const isSimple = (value: unknown): value is SimpleRefusal => (SIMPLE_REFUSALS as readonly unknown[]).includes(value);
const isStep = (value: unknown): value is BenchPrStep => (BENCH_PR_STEPS as readonly unknown[]).includes(value);
const filesOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : []);

/** The problem a failed openBenchPr carried: parseJson's status and body (#797). */
export function prProblemOf(err: unknown): PrProblem {
  const { status, body } = (err ?? {}) as { status?: unknown; body?: { error?: unknown; files?: unknown } };
  const error = body?.error;
  if (status === HTTP_CONFLICT && (error === 'conflict' || error === 'dirty')) return { error, files: filesOf(body?.files) };
  if (status === HTTP_CONFLICT && isSimple(error)) return { error };
  if (status === HTTP_BAD_REQUEST) return { error: 'invalid-branch' };
  return { error: 'failed', step: status === HTTP_BAD_GATEWAY && isStep(error) ? error : 'unknown' };
}
