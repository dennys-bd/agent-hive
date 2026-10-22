// A benchmark run's metrics (#473, from #105's harness): per task its tokens, time, waiting, stage spans and restarts; per run the sums, the
// clock less its sleep, the restarts with where, the diff, the tests the tasks reported, and the cost. Pure, except readInterventions.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resultOf, usageOf } from '../activities.js';
import type { Tokens } from '../facts.js';
import { isJsonObject } from '../state-guards.js';
import type { BenchMetrics, BenchTaskMetrics, Intervention, State, TaskUsage } from '../types.js';
import { costOf } from './prices.js';
import { DONE_STAGE, type StageEntry, type WatchState, type WatchTask } from './watcher.js';

const NO_USAGE: TaskUsage = { tokens: 0, ms: 0, waitingMs: 0, parts: [] };
const NO_DIFF: BenchMetrics['diff'] = { files: 0, insertions: 0, deletions: 0 };
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
const between = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from));
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** A run that failed before anything ran (#473): every count 0. */
export const NO_METRICS: BenchMetrics = { tokens: 0, costUsd: 0, ms: 0, waitingMs: 0, restarts: { count: 0, where: [] }, diff: NO_DIFF, tests: { green: 0, total: 0 }, tasks: [] };

export function stageSpans(entries: readonly StageEntry[], endedAt: string): { stage: string; ms: number }[] {
  return entries.flatMap((entry, i) => (entry.stage === DONE_STAGE ? [] : [{ stage: entry.stage, ms: between(entry.at, entries[i + 1]?.at ?? endedAt) }]));
}

export function parseShortstat(text: string): BenchMetrics['diff'] {
  const match = SHORTSTAT.exec(text);
  return match ? { files: Number(match[1]), insertions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) } : NO_DIFF;
}

// The stages a task restarted in, with how often: every run id past the first seen there
const restartsIn = (runs: Record<string, string[]> = {}): [string, number][] =>
  Object.entries(runs).flatMap(([stage, ids]): [string, number][] => (ids.length > 1 ? [[stage, ids.length - 1]] : []));

function taskMetrics(task: WatchTask, usage: TaskUsage | undefined, watch: WatchState, endedAt: string): BenchTaskMetrics {
  const { tokens, ms, waitingMs } = usage ?? NO_USAGE;
  const restarts = sum(restartsIn(watch.stageRuns[task.itemId]).map(([, n]) => n));
  return { key: task.key, title: task.title, tokens, ms, waitingMs, stages: stageSpans(watch.entries[task.itemId] ?? [], endedAt), restarts };
}

// One `<stage> · <key>` per stage and task that restarted, tasks in seed order: the result screen's "build · HIV-415"
const restartsWhere = (watch: WatchState): string[] =>
  watch.tasks.flatMap((t) => restartsIn(watch.stageRuns[t.itemId]).map(([stage]) => `${stage.toLowerCase()} · ${t.key}`));

// The tasks whose merged hive_done result says whether their tests passed; one that reported nothing counts in neither
function testsOf(watch: WatchState, state: Pick<State, 'activityRecords'>): BenchMetrics['tests'] {
  const reported = watch.tasks.flatMap(({ itemId }) => {
    const green = resultOf(state, itemId)?.testsGreen;
    return typeof green === 'boolean' ? [green] : [];
  });
  return { green: reported.filter(Boolean).length, total: reported.length };
}

export interface RunFacts {
  startedAt: string; endedAt: string; sleptMs: number;
  watch: WatchState; state: Pick<State, 'tasks' | 'activityRecords'>;
  diff: BenchMetrics['diff']; // parseShortstat of 3.1's git diff
  modelTokens: Record<string, Tokens>; // readModelTokens(home)
}

/** One run's BenchMetrics (#473), and the models the price table lacks, which 3.2 logs: types.benchmark keeps no such field. */
export function runMetrics(f: RunFacts): { metrics: BenchMetrics; unpriced: string[] } {
  const tasks = f.watch.tasks.map((t) => taskMetrics(t, usageOf(f.state, t.itemId), f.watch, f.endedAt));
  const { usd, unpriced } = costOf(f.modelTokens);
  const metrics: BenchMetrics = {
    tokens: sum(tasks.map((t) => t.tokens)), costUsd: usd,
    // The clock less the sleep: with several workers per arm the tasks' own times overlap, and their sum would pass the wall clock
    ms: Math.max(0, between(f.startedAt, f.endedAt) - f.sleptMs),
    waitingMs: sum(tasks.map((t) => t.waitingMs)),
    restarts: { count: sum(tasks.map((t) => t.restarts)), where: restartsWhere(f.watch) },
    diff: f.diff, tests: testsOf(f.watch, f.state), tasks,
  };
  return { metrics, unpriced };
}

export const INTERVENTIONS_FILE = 'interventions.json'; // 3.5's run mode writes it in the run's home

const isText = (value: unknown): value is string => typeof value === 'string';
const isIntervention = (value: unknown): value is Intervention =>
  isJsonObject(value) && isText(value.at) && isText(value.action) && isText(value.detail) && value.by === 'user';

async function interventionsText(home: string, log: (line: string) => void): Promise<string | undefined> {
  try {
    return await readFile(join(home, INTERVENTIONS_FILE), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log(`${home}: ${INTERVENTIONS_FILE} unreadable (${code ?? 'unknown'}), read as none`);
    return undefined;
  }
}

/** A run's interventions (#473), for 3.2's BenchRun.interventions. The file may be read mid-write, which must not fail a run: what does not
 *  parse, or is not { at, action, detail, by: 'user' }, is dropped with one line naming the home, never the content (the user's own words). */
export async function readInterventions(home: string, log: (line: string) => void): Promise<Intervention[]> {
  const text = await interventionsText(home, log);
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log(`${home}: ${INTERVENTIONS_FILE} does not parse, read as none`);
    return [];
  }
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const kept = entries.filter(isIntervention);
  if (kept.length < entries.length) log(`${home}: ${entries.length - kept.length} entries of ${INTERVENTIONS_FILE} dropped`);
  return kept;
}
