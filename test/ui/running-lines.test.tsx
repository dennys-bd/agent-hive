// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx
import { expect, test } from 'vitest';
import { ciLines, commandLines, evaluateLines, formatDuration, lineDuration, SILENCE_MS, silence } from '@/lib/running-lines';
import type { StageCommands } from '../../src/types';

const T0 = '2026-10-10T10:00:00.000Z';
const T1 = '2026-10-10T10:02:05.000Z';
const T2 = '2026-10-10T10:04:00.000Z';
const RUN: StageCommands = { stage: 'checks', at: 1, ptyId: 'P1', runId: 'R1', failed: [], workerId: 'w1', started: [T0, T1] };

test('formatDuration writes seconds, minutes and seconds, or hours and minutes; a negative span reads 0s (#914)', () => {
  expect([0, 45_000, 90_000, 3_725_000, 7_200_000, -5].map(formatDuration)).toEqual(['0s', '45s', '1m 30s', '1h 2m', '2h 0m', '0s']);
});

test('silence counts the whole minutes since the last output, else since the command started, from 2 min on; none below or without a start (#914)', () => {
  const now = Date.parse(T1) + 3 * 60_000 + 5_000;
  expect(silence(RUN, now)).toBe(3);
  expect(silence({ ...RUN, outputAt: new Date(now - 60_000).toISOString() }, now)).toBeUndefined();
  expect(silence({ ...RUN, outputAt: new Date(now - SILENCE_MS).toISOString() }, now)).toBe(2);
  expect(silence({ ...RUN, started: [T0] }, now)).toBeUndefined();
  expect(silence({ ...RUN, started: [T0, ''] }, now)).toBeUndefined();
});

test('commandLines marks each command: done, failed or skipped before the current one, running, queued after; a finished one ends where the next started (#914)', () => {
  const run: StageCommands = { ...RUN, at: 2, started: [T0, T1, T2], failed: [{ name: 'build', code: 1, output: 'x' }], skipped: [1] };
  expect(commandLines(run, ['build', 'test', 'lint', 'e2e'])).toEqual([
    { name: 'build', mark: 'failed', startedAt: T0, endedAt: T1 },
    { name: 'test', mark: 'skipped' },
    { name: 'lint', mark: 'running', startedAt: T2 },
    { name: 'e2e', mark: 'queued' },
  ]);
  expect(commandLines({ ...RUN, started: ['', T1] }, ['build', 'test'])).toEqual([{ name: 'build', mark: 'done', endedAt: T1 }, { name: 'test', mark: 'running', startedAt: T1 }]);
});

test('ciLines reads a wait\'s checks in their order: success done, failure failed, pending with a start running, else queued (#914)', () => {
  const url = 'https://github.com/acme/app/actions/runs/1/job/3';
  expect(ciLines({ checks: [
    { name: 'lint', state: 'success', startedAt: T0, completedAt: T1 },
    { name: 'build', state: 'failure', startedAt: T0, completedAt: T2 },
    { name: 'test', state: 'pending', startedAt: T1, url },
    { name: 'e2e', state: 'pending' },
  ] })).toEqual([
    { name: 'lint', mark: 'done', startedAt: T0, endedAt: T1 },
    { name: 'build', mark: 'failed', startedAt: T0, endedAt: T2 },
    { name: 'test', mark: 'running', startedAt: T1, url },
    { name: 'e2e', mark: 'queued' },
  ]);
  expect(ciLines({})).toEqual([]);
});

test('lineDuration: a finished line\'s span, a running one\'s so far, none without both ends (#914)', () => {
  const now = Date.parse(T2);
  expect(lineDuration({ name: 'build', mark: 'done', startedAt: T0, endedAt: T1 }, now)).toBe('2m 5s');
  expect(lineDuration({ name: 'test', mark: 'running', startedAt: T1 }, now)).toBe('1m 55s');
  expect(lineDuration({ name: 'docs', mark: 'done', endedAt: T1 }, now)).toBeUndefined();
  expect(lineDuration({ name: 'e2e', mark: 'queued' }, now)).toBeUndefined();
});

test('an evaluation lists each reviewer, running while it reviews and done once the judge runs, then the judge, queued then running (#877)', () => {
  const stage = { reviewers: [{ agent: 'claude' as const, focus: 'security' }, { agent: 'codex' as const, focus: 'spec' }], judge: { agent: 'claude' as const } };
  const run = { stage: 'eval', runId: 'r', workerId: 'w', startedAt: '2026-10-21T10:00:00.000Z', phase: 'reviewing' as const };
  expect(evaluateLines(run, stage, 'juiz').map((l) => [l.name, l.mark, l.startedAt])).toEqual([
    ['claude · security', 'running', run.startedAt], ['codex · spec', 'running', run.startedAt], ['juiz · claude', 'queued', undefined],
  ]);
  expect(evaluateLines({ ...run, phase: 'judging' }, stage, 'juiz').map((l) => l.mark)).toEqual(['done', 'done', 'running']);
});
