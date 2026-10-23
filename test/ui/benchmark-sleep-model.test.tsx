import { expect, test } from 'vitest';
import {
  controlPath, isDeadlinePassed, openSleep, runsToSleep, sleepBody, sleepingRuns, sleptMs, spanText, tasksInProgress, wakeBody,
} from '@/components/benchmark/sleep/sleep-model';
import { run } from '../benchmark/fixtures';
import { ASLEEP, metricsOf, SLEEPY } from './benchmark-fixtures';

const at = (local: string): Date => new Date(local); // no Z: the same wall clock on any machine
const TOKENS = ['c81e04aa', '9f2a6dbb', 'e30b71cc'];

test("the runs that sleep are the current round's running and waiting ones; the wake reads the sleeping ones (#468)", () => {
  expect(runsToSleep(SLEEPY).map((r) => r.token)).toEqual(TOKENS);
  expect(runsToSleep(ASLEEP)).toEqual([]);
  expect(sleepingRuns(ASLEEP).map((r) => r.token)).toEqual(TOKENS);
  expect(sleepingRuns(SLEEPY)).toEqual([]);
});

test('tasks in progress: the tasks with a stage less the delivered ones, floored at 0; a run without metrics counts 0 (#468)', () => {
  expect(tasksInProgress(runsToSleep(SLEEPY))).toBe(7); // the screen's 7, not the 12 that total − delivered gives
  expect(tasksInProgress([run('nometric', { delivered: 2 }), run('ahead', { delivered: 9, metrics: metricsOf(1, 1) })])).toBe(0);
});

test("the deadline passed while asleep: the next until after the sleep began is not after now; an until earlier in the day than the sleep is the next day's; no until or no open sleep, never (#468)", () => {
  expect(isDeadlinePassed(ASLEEP, at('2026-10-02T06:45:00'))).toBe(false);
  expect(isDeadlinePassed(ASLEEP, at('2026-10-02T07:00:00'))).toBe(true);
  const late: typeof ASLEEP = { ...ASLEEP, sleeps: [{ round: 2, at: '2026-10-02T22:00:00', reason: 'r' }] };
  expect(isDeadlinePassed(late, at('2026-10-02T23:30:00'))).toBe(false);
  expect(isDeadlinePassed(late, at('2026-10-03T07:01:00'))).toBe(true);
  const { until: _until, ...pace } = ASLEEP.pace;
  expect(isDeadlinePassed({ ...ASLEEP, pace }, at('2026-10-03T07:01:00'))).toBe(false);
  expect(isDeadlinePassed({ ...ASLEEP, sleeps: [] }, at('2026-10-03T07:01:00'))).toBe(false);
});

test('the slept span sums every sleep, the open one up to now, written as report.md writes a span (#468)', () => {
  const twice: typeof ASLEEP = { ...ASLEEP, sleeps: [{ round: 1, at: '2026-10-02T00:10:00', wokeAt: '2026-10-02T00:45:00', reason: 'a' }, ...ASLEEP.sleeps] };
  expect(openSleep(twice)).toEqual(ASLEEP.sleeps[0]);
  expect(openSleep(SLEEPY)).toBeUndefined();
  expect(spanText(sleptMs(ASLEEP, at('2026-10-02T06:45:00')))).toBe('2h05');
  expect(spanText(sleptMs(twice, at('2026-10-02T06:45:00')))).toBe('2h40');
  expect([spanText(45 * 60_000), spanText(0)]).toEqual(['45m', '0m']);
});

test("the bodies: sleep trims the reason and carries wakeAt only when given; wake keeps the deadline unless it passed, then each option's (#468)", () => {
  expect(sleepBody('  preciso  ')).toEqual({ reason: 'preciso' });
  expect(sleepBody('preciso', '13:00')).toEqual({ reason: 'preciso', wakeAt: '13:00' });
  expect(wakeBody(false, 'none', '')).toEqual({});
  expect(wakeBody(true, 'finish-round', '')).toEqual({ deadline: 'finish-round' });
  expect(wakeBody(true, 'until', '13:00')).toEqual({ deadline: { until: '13:00' } });
  expect(wakeBody(true, 'none', '')).toEqual({ deadline: 'none' });
  expect(controlPath('skills-20261001-2130', 'wake')).toBe('/benchmark/experiments/skills-20261001-2130/wake');
});
