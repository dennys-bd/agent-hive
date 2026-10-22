import { BENCHMARK_PR_IN, type BenchmarkPrIn } from './types.js';

// A workspace's benchmarkPrIn (#477), out of config.ts, which is past 400 lines. Required, no migration: one message for missing and unknown,
// naming both values, as requireTheme does.
const FILE = 'hive.config.json';

export function parseBenchmarkPrIn(raw: unknown, field: string): BenchmarkPrIn {
  if (!BENCHMARK_PR_IN.includes(raw as BenchmarkPrIn)) throw new Error(`${FILE}: "${field}.benchmarkPrIn" must be one of: ${BENCHMARK_PR_IN.join(', ')}`);
  return raw as BenchmarkPrIn;
}
