import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRateLimits, isRateLimits, MAX_WINDOWS, parseRateLimits, windowLabel } from '../src/rate-limits.js';
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
  assert.equal(formatRateLimits(PARSED), 'sessão 23% · semana 41%');
  const fable: RateLimits = { at: PARSED.at, windows: { ...PARSED.windows, seven_day_fable: { usedPercent: 99.5, resetsAt: PARSED.at } } };
  assert.equal(formatRateLimits(fable), 'sessão 23% · semana 41% · semana fable 100%');
  assert.equal(windowLabel('five_hour'), 'sessão');
  assert.equal(windowLabel('seven_day'), 'semana');
  assert.equal(windowLabel('seven_day_fable'), 'semana fable');
  assert.equal(windowLabel('seven_day_opus'), 'semana opus');
  assert.equal(windowLabel('spend_limit'), 'spend limit');
  assert.equal(windowLabel('constructor'), 'constructor', 'an inherited property name is not a label');
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
