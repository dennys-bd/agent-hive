import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.js';
import { countdown, describeRules, duration, elapsed, fmt, HOUR_MS, inBackoff, latestQuota, meterBand, nextMorning, pauseUntil, percent, sourcePercent, timeLeft, usageTotals, windowLabel, windowResetsAt, withinLimit } from '../src/ui/lib/usage.js';
import type { SourceQuota, SourceSync, State, UsageRule } from '../src/types.js';

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

test('usageTotals sums the last hour and the last 24 h separately', () => {
  const usage = [{ at: at(10), tokens: 100 }, { at: at(90), tokens: 1_000 }, { at: at(23 * 60), tokens: 10_000 }, { at: at(25 * 60), tokens: 100_000 }];
  assert.deepEqual(usageTotals(usage, NOW), { hour: 100, day: 11_100 });
  assert.deepEqual(usageTotals([], NOW), { hour: 0, day: 0 });
});

test('withinLimit treats 0 and absent as no limit; percent rounds', () => {
  assert.equal(withinLimit(5_000), true);
  assert.equal(withinLimit(5_000, 0), true);
  assert.equal(withinLimit(4_999, 5_000), true);
  assert.equal(withinLimit(5_000, 5_000), false);
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(2_500, 5_000), 50);
});

test('fmt shortens to k and M with one decimal', () => {
  assert.equal(fmt(842), '842');
  assert.equal(fmt(12_300), '12.3k');
  assert.equal(fmt(1_200_000), '1.2M');
});

test('elapsed prints minutes below an hour and h + min above; nothing without a start', () => {
  assert.equal(elapsed(undefined, NOW), '');
  assert.equal(elapsed(at(5), NOW), '5 min');
  assert.equal(elapsed(at(125), NOW), '2 h 5 min');
});

test('duration prints whole minutes below an hour and h + min above; elapsed is the duration since a start (#248)', () => {
  assert.equal(duration(0), '0 min');
  assert.equal(duration(59_999), '0 min');
  assert.equal(duration(72 * 60_000), '1 h 12 min');
  assert.equal(elapsed(at(72), NOW), duration(72 * 60_000));
});

test('countdown prints the two largest non-zero units, drops a zero smaller unit, and clamps to 0m once passed', () => {
  const from = (msFromNow: number): string => new Date(NOW + msFromNow).toISOString();
  assert.equal(countdown(from(24 * 3_600_000 + 12 * 3_600_000), NOW), '1d12h');
  assert.equal(countdown(from(2 * 3_600_000 + 40 * 60_000), NOW), '2h40m');
  assert.equal(countdown(from(45 * 60_000), NOW), '45m');
  assert.equal(countdown(from(3 * 3_600_000), NOW), '3h');
  assert.equal(countdown(from(2 * 24 * 3_600_000), NOW), '2d');
  assert.equal(countdown(from(-60_000), NOW), '0m');
  assert.equal(countdown(from(0), NOW), '0m');
  assert.equal(countdown('not-a-date', NOW), '0m');
});

test('meterBand is neutral below 70%, yellow from 70%, red from 90%', () => {
  assert.equal(meterBand(69), 'neutral');
  assert.equal(meterBand(70), 'yellow');
  assert.equal(meterBand(89), 'yellow');
  assert.equal(meterBand(90), 'red');
  assert.equal(meterBand(150), 'red');
});

test('windowLabel follows the language for the known windows, prefixes weekly model windows and humanizes the rest', () => {
  setLanguage('en');
  assert.equal(windowLabel('five_hour'), 'session');
  assert.equal(windowLabel('seven_day'), 'week');
  assert.equal(windowLabel('seven_day_opus'), 'week opus');
  assert.equal(windowLabel('some_other_window'), 'some other window');
  setLanguage('pt');
  assert.equal(windowLabel('five_hour'), 'sessão');
});

test('describeRules joins source ≥ N% with a comma, the source names from the dictionary; empty for no rules', () => {
  const rules: UsageRule[] = [{ source: 'session', percent: 80, signal: 'yellow' }, { source: 'week', percent: 70, maxWorkers: 4 }];
  setLanguage('en');
  assert.equal(describeRules(rules), 'session ≥ 80%, week ≥ 70%');
  assert.equal(describeRules([{ source: 'hour', percent: 50, maxWorkers: 1 }, { source: 'day', percent: 60, maxWorkers: 1 }]), 'hour ≥ 50%, day ≥ 60%');
  assert.equal(describeRules([]), '');
  setLanguage('pt');
  assert.equal(describeRules(rules), 'sessão ≥ 80%, semana ≥ 70%');
});

test('describeRules takes an optional joiner, used by the strip to join rules inside one clause with "and"', () => {
  setLanguage('en');
  const rules: UsageRule[] = [{ source: 'session', percent: 60, signal: 'yellow' }, { source: 'week', percent: 50, signal: 'yellow' }];
  assert.equal(describeRules(rules, ' and '), 'session ≥ 60% and week ≥ 50%');
});

test('inBackoff is true only when remaining is below the reserve and the reset is still ahead', () => {
  assert.equal(inBackoff(undefined, NOW), false);
  assert.equal(inBackoff({ limit: 5_000, remaining: 4_000, resetsAt: at(-60), at: at(0) }, NOW), false);
  assert.equal(inBackoff({ limit: 5_000, remaining: 100, resetsAt: at(10), at: at(0) }, NOW), false);
  assert.equal(inBackoff({ limit: 5_000, remaining: 100, resetsAt: at(-10), at: at(0) }, NOW), true);
});

test('pauseUntil: reset as it is; 15 min, 1 h and 4 h from now; até amanhã the next local 07:00, today before 07:00 (redesign 02)', () => {
  const now = new Date(2026, 8, 25, 14, 30).getTime(); // local 14:30
  assert.deepEqual(pauseUntil('reset', now), { kind: 'reset' });
  assert.deepEqual(pauseUntil('quarter', now), { kind: 'at', at: new Date(now + HOUR_MS / 4).toISOString() });
  assert.deepEqual(pauseUntil('hour', now), { kind: 'at', at: new Date(now + HOUR_MS).toISOString() });
  assert.deepEqual(pauseUntil('fourHours', now), { kind: 'at', at: new Date(now + 4 * HOUR_MS).toISOString() });
  assert.deepEqual(pauseUntil('tomorrow', now), { kind: 'at', at: new Date(2026, 8, 26, 7, 0).toISOString() });
  assert.deepEqual(nextMorning(new Date(2026, 8, 25, 3, 0).getTime()), new Date(2026, 8, 25, 7, 0));
});

test('timeLeft reads minutes under a day and the countdown beyond, never negative', () => {
  const now = new Date(2026, 8, 25, 14, 30).getTime();
  assert.equal(timeLeft(new Date(now + 52 * 60_000).toISOString(), now), '52 min');
  assert.equal(timeLeft(new Date(now + 4 * 24 * HOUR_MS + 10 * HOUR_MS).toISOString(), now), '4d10h');
  assert.equal(timeLeft(new Date(now - HOUR_MS).toISOString(), now), '0 min');
});

test('windowResetsAt: a plan source reads its window, a budget source has none', () => {
  const rateLimits = { at: 'x', windows: { seven_day: { usedPercent: 90, resetsAt: '2026-09-30T00:00:00Z' } } };
  assert.equal(windowResetsAt({ rateLimits }, 'week'), '2026-09-30T00:00:00Z');
  assert.equal(windowResetsAt({ rateLimits }, 'session'), undefined);
  assert.equal(windowResetsAt({ rateLimits }, 'hour'), undefined);
});

test('sourcePercent: the plan windows as last read (0 past reset, undefined with no reading), the budget sources as a share of the sample (undefined with no limit) (#512)', () => {
  const state: Pick<State, 'usage' | 'budget' | 'rateLimits'> = {
    usage: [{ at: at(10), tokens: 500 }],
    budget: { maxTokensPerHour: 1_000 },
    rateLimits: { at: at(0), windows: { five_hour: { usedPercent: 11.4, resetsAt: at(-60) } } },
  };
  assert.equal(sourcePercent(state, 'session', NOW), 11);
  const past: Pick<State, 'usage' | 'budget' | 'rateLimits'> = { ...state, rateLimits: { at: at(0), windows: { five_hour: { usedPercent: 11.4, resetsAt: at(60) } } } };
  assert.equal(sourcePercent(past, 'session', NOW), 0, 'a window already past its reset reads 0');
  assert.equal(sourcePercent(state, 'week', NOW), undefined, 'no seven_day window: nothing to measure');
  assert.equal(sourcePercent(state, 'hour', NOW), 50);
  assert.equal(sourcePercent(state, 'day', NOW), undefined, 'no maxTokensPerDay: no limit to share');
});

test('latestQuota: the freshest reading among the sources; a source without one is skipped; {} is undefined (#512)', () => {
  const quota = (at2: string): SourceQuota => ({ limit: 5_000, remaining: 100, resetsAt: at(-60), at: at2 });
  const syncs: Record<string, SourceSync> = {
    old: { quota: quota('2026-09-17T10:00:00.000Z') },
    fresh: { quota: quota('2026-09-17T12:00:00.000Z') },
    none: {},
  };
  assert.deepEqual(latestQuota(syncs), syncs.fresh.quota);
  assert.equal(latestQuota({}), undefined);
});
