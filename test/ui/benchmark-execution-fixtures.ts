import type { BenchMetrics, BenchRun, BenchRunStatus, BenchTask, Experiment, TaskProgressState } from '../../src/types';
import { arm, experiment, run } from '../benchmark/fixtures';

// Local times (no Z): HH:MM reads the same on any machine
export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const NOW = Date.parse('2026-10-22T07:10:00');
const R1_START = '2026-10-21T22:01:00';
const R1_END = '2026-10-22T03:57:00';
const R2_START = '2026-10-22T03:58:00';

const tasks = (n: number): BenchTask[] => Array.from({ length: n }, (_, i) => ({ key: `T${i + 1}`, title: `task ${i + 1}`, body: '', blockedBy: [] }));
export const bar = (done: number, waiting: number, open: number): TaskProgressState[] =>
  [...Array<TaskProgressState>(done).fill('done'), ...Array<TaskProgressState>(waiting).fill('waiting'), ...Array<TaskProgressState>(open).fill('open')];
const metrics = (tokens: number, ms = 0): BenchMetrics => ({
  tokens, costUsd: 0, ms, waitingMs: 0, restarts: { count: 0, where: [] }, diff: { files: 0, insertions: 0, deletions: 0 }, tests: { green: 0, total: 0 }, tasks: [],
});
const live = (token: string, armId: string, status: BenchRunStatus, progress: TaskProgressState[], tokens: number): BenchRun => run(token, {
  armId, round: 2, status, startedAt: R2_START, progress, delivered: progress.filter((s) => s === 'done').length, total: progress.length, metrics: metrics(tokens),
});
const ended = (token: string, armId: string, status: BenchRunStatus, total: number, tokens: number, ms: number, progress?: TaskProgressState[]): BenchRun => run(token, {
  armId, round: 1, status, startedAt: R1_START, endedAt: R1_END, delivered: progress?.filter((s) => s === 'done').length ?? total, total, metrics: metrics(tokens, ms),
  ...(progress === undefined ? {} : { progress }),
});

/** benchmark.hv.html's #s-execucao: four arms (D with 3 tasks of its own), round 1 evaluated, round 2 running, round 3 queued. Its sleep makes
 *  "em execução há" 3h12: now − 22:01 − 5h57 asleep. */
export const SCREEN: Experiment = experiment({
  id: 'skills-20261001-2130', name: 'skills: comandos × plugin', status: 'running',
  arms: [arm('a1', 'A'), arm('a2', 'B'), arm('a3', 'C'), arm('a4', 'D', { tasks: tasks(3) })],
  base: { ...experiment().base, tasks: tasks(8) }, pace: { ...experiment().pace, pairs: 3, until: '07:00' },
  sleeps: [{ round: 1, at: '2026-10-21T23:00:00', wokeAt: '2026-10-22T04:57:00', reason: 'night' }],
  rounds: [
    { n: 1, startedAt: R1_START, endedAt: R1_END, evaluatedAt: R2_START, runs: [
      ended('a41f9c01', 'a1', 'done', 8, 3_200_000, 5 * HOUR + 40 * MINUTE), ended('7d03b201', 'a2', 'done', 8, 2_600_000, 4 * HOUR + 55 * MINUTE),
      ended('e5c91101', 'a3', 'timeout', 8, 2_900_000, 6 * HOUR, bar(6, 0, 2)), ended('4a77c001', 'a4', 'done', 3, 2_100_000, 4 * HOUR + 18 * MINUTE),
    ] },
    { n: 2, startedAt: R2_START, runs: [
      live('c81e04aa', 'a1', 'running', bar(5, 2, 1), 1_900_000), live('9f2a6daa', 'a2', 'waiting', bar(4, 1, 3), 1_400_000),
      live('41b7e3aa', 'a3', 'running', bar(3, 3, 2), 1_100_000), live('b5e912aa', 'a4', 'running', bar(2, 0, 1), 1_100_000),
    ] },
  ],
});
