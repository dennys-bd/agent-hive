import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimits, parseUsage } from '../src/agents/claude-limits.js';
import { formatRateLimits, isRateLimits, MAX_WINDOWS, mergeRateLimits, windowLabel } from '../src/rate-limits.js';
import type { RateLimits } from '../src/types.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');
// The example from the Claude Code status line docs: resets_at in epoch seconds
const FIVE_HOUR = { used_percentage: 23.4, resets_at: 1759744800 };
const SEVEN_DAY = { used_percentage: 41, resets_at: 1760263200 };
const DOCS = { rate_limits: { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY } };
const PARSED: RateLimits = {
  at: '2026-09-16T12:00:00.000Z',
  windows: {
    five_hour: { usedPercent: 23.4, resetsAt: '2025-10-06T10:00:00.000Z' },
    seven_day: { usedPercent: 41, resetsAt: '2025-10-12T10:00:00.000Z' },
  },
};

test('parseRateLimits reads the docs example into two windows with ISO resets and stamps the arrival time', () => {
  assert.deepEqual(parseRateLimits(DOCS, NOW), PARSED);
  assert.equal(parseRateLimits(DOCS, NOW)?.at, NOW.toISOString());
});

test('parseRateLimits keeps any extra window under its own key', () => {
  const body = { rate_limits: { ...DOCS.rate_limits, seven_day_fable: { used_percentage: 7, resets_at: 1760263200 } } };
  const parsed = parseRateLimits(body, NOW);
  assert.deepEqual(Object.keys(parsed?.windows ?? {}), ['five_hour', 'seven_day', 'seven_day_fable']);
  assert.deepEqual(parsed?.windows.seven_day_fable, { usedPercent: 7, resetsAt: '2025-10-12T10:00:00.000Z' });
});

test('parseRateLimits drops a window with a bad key, a non-numeric used_percentage or a missing resets_at', () => {
  const body = {
    rate_limits: {
      ...DOCS.rate_limits,
      'Five-Hour': FIVE_HOUR,
      '9lives': FIVE_HOUR,
      ['a'.repeat(33)]: FIVE_HOUR,
      text: { used_percentage: '23', resets_at: 1759744800 },
      negative: { used_percentage: -1, resets_at: 1759744800 },
      no_reset: { used_percentage: 5 },
      zero_reset: { used_percentage: 5, resets_at: 0 },
      fraction: { used_percentage: 5, resets_at: 1.5 },
      nothing: null,
      number: 7,
    },
  };
  assert.deepEqual(parseRateLimits(body, NOW), PARSED);
  const onlyBad = { rate_limits: { five_hour: { used_percentage: '23', resets_at: 1759744800 } } };
  assert.equal(parseRateLimits(onlyBad, NOW), undefined, 'no valid window: nothing to dispatch');
  const over = { rate_limits: { five_hour: { used_percentage: 1e9, resets_at: 1759744800 } } };
  assert.equal(parseRateLimits(over, NOW)?.windows.five_hour.usedPercent, 100, 'a percent above 100 is clamped, not dropped');
});

test('parseRateLimits keeps at most MAX_WINDOWS windows, in payload order', () => {
  assert.equal(MAX_WINDOWS, 8);
  const rate_limits = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, FIVE_HOUR]));
  const windows = parseRateLimits({ rate_limits }, NOW)?.windows ?? {};
  assert.deepEqual(Object.keys(windows), Array.from({ length: MAX_WINDOWS }, (_, i) => `w${i}`));
});

test('parseRateLimits is undefined without rate_limits or for a body that is not an object', () => {
  const bodies: unknown[] = [undefined, null, 'x', 5, [], {}, { rate_limits: null }, { rate_limits: [] }, { rate_limits: 'x' }, { rate_limits: {} }];
  for (const body of bodies) assert.equal(parseRateLimits(body, NOW), undefined, String(JSON.stringify(body)));
});

test('formatRateLimits is the status line — label, rounded percent, dot-separated — and windowLabel names every key', () => {
  assert.equal(formatRateLimits(PARSED, 'pt'), 'sessão 23% · semana 41%');
  const fable: RateLimits = { at: PARSED.at, windows: { ...PARSED.windows, seven_day_fable: { usedPercent: 99.5, resetsAt: PARSED.at } } };
  assert.equal(formatRateLimits(fable, 'pt'), 'sessão 23% · semana 41% · semana fable 100%');
  assert.equal(windowLabel('five_hour', 'pt'), 'sessão');
  assert.equal(windowLabel('seven_day', 'pt'), 'semana');
  assert.equal(windowLabel('seven_day_fable', 'pt'), 'semana fable');
  assert.equal(windowLabel('seven_day_opus', 'pt'), 'semana opus');
  assert.equal(windowLabel('spend_limit', 'pt'), 'spend limit');
  assert.equal(windowLabel('constructor', 'pt'), 'constructor', 'an inherited property name is not a label');
});

test('formatRateLimits and windowLabel in English: session / week, the weekly prefix translated, other keys as they are', () => {
  assert.equal(formatRateLimits(PARSED, 'en'), 'session 23% · week 41%');
  const fable: RateLimits = { at: PARSED.at, windows: { ...PARSED.windows, seven_day_fable: { usedPercent: 99.5, resetsAt: PARSED.at } } };
  assert.equal(formatRateLimits(fable, 'en'), 'session 23% · week 41% · week fable 100%');
  assert.equal(windowLabel('seven_day_opus', 'en'), 'week opus');
  assert.equal(windowLabel('spend_limit', 'en'), 'spend limit');
  assert.equal(windowLabel('constructor', 'en'), 'constructor');
});

// What GET /api/oauth/usage answers on a Max plan: per-model weekly windows present, unused ones null, extra_usage alongside
const USAGE = {
  five_hour: { utilization: 23.4, resets_at: '2026-09-17T15:00:00.000Z' },
  seven_day: { utilization: 41, resets_at: '2026-09-21T00:00:00Z' },
  seven_day_opus: { utilization: 7.5, resets_at: '2026-09-21T00:00:00+00:00' },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0, utilization: null },
};
const USAGE_PARSED: RateLimits = {
  at: '2026-09-16T12:00:00.000Z',
  windows: {
    five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' },
    seven_day: { usedPercent: 41, resetsAt: '2026-09-21T00:00:00.000Z' },
    seven_day_opus: { usedPercent: 7.5, resetsAt: '2026-09-21T00:00:00.000Z' },
  },
};

test('parseUsage reads the usage endpoint body: one window per key with utilization and an ISO resets_at, nulls and extras dropped', () => {
  assert.deepEqual(parseUsage(USAGE, NOW), USAGE_PARSED);
  assert.deepEqual(Object.keys(parseUsage(USAGE, NOW)?.windows ?? {}), ['five_hour', 'seven_day', 'seven_day_opus'], 'payload order');
});

test('parseUsage clamps a utilization above 100 and drops a window whose resets_at does not parse', () => {
  const over = { five_hour: { utilization: 250, resets_at: '2026-09-17T15:00:00Z' } };
  assert.equal(parseUsage(over, NOW)?.windows.five_hour.usedPercent, 100);
  const bad = { ...USAGE, seven_day: { utilization: 41, resets_at: 'soon' } };
  assert.deepEqual(Object.keys(parseUsage(bad, NOW)?.windows ?? {}), ['five_hour', 'seven_day_opus']);
  assert.equal(parseUsage({ five_hour: { utilization: 1, resets_at: 'soon' } }, NOW), undefined, 'no surviving window');
});

test('parseUsage is undefined for a body that is not an object or has no valid window', () => {
  const iso = '2026-09-17T15:00:00Z';
  const bodies: unknown[] = [
    undefined, null, 'x', 5, [], {}, { five_hour: null }, { five_hour: 7 },
    { five_hour: { utilization: '23', resets_at: iso } }, { five_hour: { utilization: -1, resets_at: iso } },
    { five_hour: { utilization: 1, resets_at: 1759744800 } }, { 'Five-Hour': { utilization: 1, resets_at: iso } },
  ];
  for (const body of bodies) assert.equal(parseUsage(body, NOW), undefined, String(JSON.stringify(body)));
});

test('parseUsage keeps at most MAX_WINDOWS windows, like parseRateLimits', () => {
  const body = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, { utilization: i, resets_at: '2026-09-17T15:00:00Z' }]));
  assert.deepEqual(Object.keys(parseUsage(body, NOW)?.windows ?? {}), Array.from({ length: MAX_WINDOWS }, (_, i) => `w${i}`));
});

test('isRateLimits accepts the parsed shape and rejects anything else', () => {
  assert.equal(isRateLimits(PARSED), true);
  assert.equal(isRateLimits({ at: PARSED.at, windows: {} }), true, 'no window is still the shape');
  const withWindow = (window: unknown): unknown => ({ at: PARSED.at, windows: { five_hour: window } });
  assert.equal(isRateLimits(withWindow({ usedPercent: 1, resetsAt: 7 })), false, 'resetsAt must be a string');
  assert.equal(isRateLimits(withWindow({ usedPercent: '1', resetsAt: 'x' })), false);
  assert.equal(isRateLimits(withWindow({ resetsAt: 'x' })), false);
  assert.equal(isRateLimits(withWindow(null)), false);
  assert.equal(isRateLimits(withWindow({ usedPercent: -1, resetsAt: 'x' })), false, 'same bounds as parseWindow');
  assert.equal(isRateLimits(withWindow({ usedPercent: 101, resetsAt: 'x' })), false);
  assert.equal(isRateLimits({ at: PARSED.at, windows: { 'Bad Key': { usedPercent: 1, resetsAt: 'x' } } }), false, 'same key rule as parseRateLimits');
  assert.equal(isRateLimits({ at: 5, windows: {} }), false);
  assert.equal(isRateLimits({ at: PARSED.at, windows: [] }), false);
  assert.equal(isRateLimits({ at: PARSED.at }), false);
  for (const value of [undefined, null, 'x', 5, []]) assert.equal(isRateLimits(value), false, String(value));
});

const reading = (usedPercent: number, resetsAt: string, at = '2026-09-16T12:00:00.000Z'): RateLimits =>
  ({ at, windows: { five_hour: { usedPercent, resetsAt } } });
const NEXT_WINDOW = '2026-09-16T20:00:00.000Z';
const THIS_WINDOW = '2026-09-16T15:00:00.000Z';

test('mergeRateLimits keeps the freshest reading per window: higher inside the window, the later reset outright, the earlier one dropped', () => {
  const held = reading(85, THIS_WINDOW);
  assert.deepEqual(mergeRateLimits(undefined, held), held, 'nothing held: the reading is the state');
  assert.deepEqual(mergeRateLimits(held, reading(20, THIS_WINDOW, 'later')).windows, held.windows, 'a stale snapshot of this window changes nothing');
  assert.equal(mergeRateLimits(held, reading(20, THIS_WINDOW, 'later')).at, 'later', 'at is always when the Hive last heard a reading');
  assert.deepEqual(mergeRateLimits(held, reading(90, THIS_WINDOW)).windows, reading(90, THIS_WINDOW).windows, 'use grew');
  assert.deepEqual(mergeRateLimits(held, reading(2, NEXT_WINDOW)).windows, reading(2, NEXT_WINDOW).windows, 'the window rolled: the lower reading is the truth');
  assert.deepEqual(mergeRateLimits(held, reading(99, '2026-09-16T13:00:00.000Z')).windows, held.windows, 'a window that already reset is behind: dropped');
});

test('mergeRateLimits reads a reset that jitters by a second as the same window, so the usage endpoint still moves the meter', () => {
  const held = reading(0, '2026-09-16T15:00:00.355Z');
  const jittered = reading(31, '2026-09-16T15:00:00.315Z'); // what /api/oauth/usage returns from one call to the next
  assert.deepEqual(mergeRateLimits(held, jittered).windows, jittered.windows, 'same window, use grew');
  assert.equal(mergeRateLimits(reading(31, '2026-09-16T15:00:01.002Z'), held).windows.five_hour.usedPercent, 31, 'a lower reading of the same window is still stale');
});

test('mergeRateLimits merges window by window and keeps a window the reading does not carry', () => {
  const held: RateLimits = { at: 'a', windows: { five_hour: { usedPercent: 85, resetsAt: THIS_WINDOW }, seven_day: { usedPercent: 41, resetsAt: NEXT_WINDOW } } };
  const merged = mergeRateLimits(held, reading(2, NEXT_WINDOW, 'b'));
  assert.deepEqual(merged, { at: 'b', windows: { five_hour: { usedPercent: 2, resetsAt: NEXT_WINDOW }, seven_day: { usedPercent: 41, resetsAt: NEXT_WINDOW } } });
});
