import { resultOf, usageOf } from '../../src/activities.js';
import type { State, Task, TaskUsage } from '../../src/types.js';
import type { DiffSize, Metrics, StageSpan, TaskMetrics } from './types.js';
import { DONE_STAGE, type StageEntry, type WatchEnd, type WatchState } from '../../src/benchmark/watcher.js';

const NO_USAGE: TaskUsage = { tokens: 0, ms: 0, waitingMs: 0, parts: [] };
const NO_DIFF: DiffSize = { files: 0, insertions: 0, deletions: 0 };
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
const between = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from));
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

export function stageSpans(entries: readonly StageEntry[], endedAt: string): StageSpan[] {
  return entries.flatMap((entry, i) => (entry.stage === DONE_STAGE ? [] : [{ stage: entry.stage, ms: between(entry.at, entries[i + 1]?.at ?? endedAt) }]));
}

// #473: a restart in any stage, as the benchmark counts it
const restartsOf = (runs: Record<string, string[]> = {}): number => Object.values(runs).reduce((n, ids) => n + Math.max(0, ids.length - 1), 0);

export function taskMetrics(itemId: string, task: Task | undefined, usage: TaskUsage | undefined, watch: WatchState, endedAt: string): TaskMetrics {
  const { tokens, ms, waitingMs } = usage ?? NO_USAGE;
  return { itemId, id: task?.item.id ?? itemId, tokens, ms, waitingMs, stages: stageSpans(watch.entries[itemId] ?? [], endedAt), buildRestarts: restartsOf(watch.stageRuns[itemId]) };
}

export function parseShortstat(text: string): DiffSize {
  const match = SHORTSTAT.exec(text);
  return match ? { files: Number(match[1]), insertions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) } : NO_DIFF;
}

// The task whose Merge last touched the run branch
function lastDone(watch: WatchState): string | undefined {
  const done = watch.tasks.flatMap(({ itemId }) => {
    const at = watch.entries[itemId]?.find((e) => e.stage === DONE_STAGE)?.at;
    return at === undefined ? [] : [{ itemId, at: Date.parse(at) }];
  });
  return done.sort((x, y) => y.at - x.at)[0]?.itemId;
}

export interface RunFacts {
  token: string; startedAt: string; endedAt: string;
  end: WatchEnd; watch: WatchState; state: Pick<State, 'tasks' | 'activityRecords'>; diff: DiffSize; unpaired?: boolean;
}

export function runMetrics(f: RunFacts): Metrics {
  const tasks = f.watch.tasks.map(({ itemId }) => taskMetrics(itemId, f.state.tasks.find((t) => t.item.itemId === itemId), usageOf(f.state, itemId), f.watch, f.endedAt));
  const doneId = lastDone(f.watch);
  const reported = doneId === undefined ? undefined : resultOf(f.state, doneId)?.testsGreen;
  return {
    token: f.token, outcome: f.end.outcome, ...(f.end.outcome === 'error' ? { reason: f.end.reason } : {}),
    startedAt: f.startedAt, endedAt: f.endedAt, tasks,
    tokens: sum(tasks.map((t) => t.tokens)), ms: sum(tasks.map((t) => t.ms)), waitingMs: sum(tasks.map((t) => t.waitingMs)),
    buildRestarts: sum(tasks.map((t) => t.buildRestarts)), diff: f.diff,
    ...(typeof reported === 'boolean' ? { reportedTestsGreen: reported } : {}), ...(f.unpaired ? { unpaired: true as const } : {}),
  };
}

export const failedMetrics = (token: string, at: string, reason: string, unpaired = false): Metrics => ({
  token, outcome: 'error', reason, startedAt: at, endedAt: at, tasks: [], tokens: 0, ms: 0, waitingMs: 0, buildRestarts: 0, diff: NO_DIFF,
  ...(unpaired ? { unpaired: true as const } : {}),
});
