import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.js';
import { elapsed, fmt, isFree, percent, usageTotals, windowLabel, withinLimit } from '../src/ui/lib/usage.js';

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

test('windowLabel follows the language for the known windows, prefixes weekly model windows and humanizes the rest; isFree ignores draining slots', () => {
  setLanguage('en');
  assert.equal(windowLabel('five_hour'), 'session');
  assert.equal(windowLabel('seven_day'), 'week');
  assert.equal(windowLabel('seven_day_opus'), 'week opus');
  assert.equal(windowLabel('some_other_window'), 'some other window');
  setLanguage('pt');
  assert.equal(windowLabel('five_hour'), 'sessão');
  assert.equal(isFree({ id: 's1', status: 'empty' }), true);
  assert.equal(isFree({ id: 's1', status: 'empty', draining: true }), false);
  assert.equal(isFree({ id: 's1', status: 'working' }), false);
});
