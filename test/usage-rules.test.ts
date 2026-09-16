import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR_MS } from '../src/usage.js';
import { applyUsageRules, SIGNAL_RANK, usedPercent, worstSignal } from '../src/usage-rules.js';
import type { Budget, UsageRule, UsageSample } from '../src/types.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const HOUR = 2_000_000;
const DAY = 20_000_000;
const BUDGET: Budget = { maxTokensPerHour: HOUR, maxTokensPerDay: DAY };
// the roadmap table
const RULES: UsageRule[] = [
  { percent: 50, maxWorkers: 4 },
  { percent: 60, maxWorkers: 3 },
  { percent: 80, signal: 'yellow' },
  { percent: 90, signal: 'red' },
];
// one sample `ageMs` before NOW
const sample = (tokens: number, ageMs = 0): UsageSample => ({ at: new Date(NOW - ageMs).toISOString(), tokens });
const hourAt = (percent: number): UsageSample[] => [sample((HOUR / 100) * percent)];

test('usedPercent is 0 without samples, without a budget, or with a zero limit', () => {
  assert.equal(usedPercent([], BUDGET, NOW), 0);
  assert.equal(usedPercent(hourAt(50), {}, NOW), 0, 'a budget with no window set');
  assert.equal(usedPercent(hourAt(50), { maxTokensPerHour: 0 }, NOW), 0, 'a zero limit is no limit, never a division by zero');
});

test('usedPercent takes the tighter of the hour and day windows, only over the windows with a limit', () => {
  assert.equal(usedPercent([sample(1_000_000)], BUDGET, NOW), 50);
  assert.equal(usedPercent([sample(15_000_000, 2 * HOUR_MS)], BUDGET, NOW), 75, 'older than an hour: counts for the day only');
  assert.equal(usedPercent([sample(1_000_000), sample(14_000_000, 2 * HOUR_MS)], BUDGET, NOW), 75, 'the worst window wins');
  assert.equal(usedPercent([sample(100), sample(15_000_000, 2 * HOUR_MS)], { maxTokensPerHour: 1000 }, NOW), 10, 'day ignored without a day limit');
  assert.equal(usedPercent([sample(3_000_000)], BUDGET, NOW), 150, 'over budget reads above 100');
  assert.equal(usedPercent([sample(1_140_000)], BUDGET, NOW), 57, 'exact share reads exactly, no float drift');
});

test('applyUsageRules fires every rule at or below the used percent; worst signal and smallest cap win', () => {
  const at = (percent: number) => applyUsageRules(hourAt(percent), BUDGET, RULES, NOW);
  assert.deepEqual(at(0), { signal: 'green' });
  assert.deepEqual(at(49), { signal: 'green' });
  assert.deepEqual(at(50), { signal: 'green', maxWorkers: 4 }, 'the boundary fires');
  assert.deepEqual(at(55), { signal: 'green', maxWorkers: 4 });
  assert.deepEqual(at(65), { signal: 'green', maxWorkers: 3 });
  assert.deepEqual(at(85), { signal: 'yellow', maxWorkers: 3 });
  assert.deepEqual(at(95), { signal: 'red', maxWorkers: 3 });
});

test('applyUsageRules ignores array order, adds no maxWorkers key for a signal-only rule, and is green without data', () => {
  assert.deepEqual(applyUsageRules(hourAt(95), BUDGET, [...RULES].reverse(), NOW), applyUsageRules(hourAt(95), BUDGET, RULES, NOW));
  assert.deepEqual(applyUsageRules(hourAt(85), BUDGET, [RULES[2]], NOW), { signal: 'yellow' });
  assert.deepEqual(applyUsageRules([], BUDGET, RULES, NOW), { signal: 'green' });
  assert.deepEqual(applyUsageRules(hourAt(95), {}, RULES, NOW), { signal: 'green' });
  assert.deepEqual(applyUsageRules(hourAt(95), BUDGET, [], NOW), { signal: 'green' });
});

test('worstSignal ranks green < yellow < red', () => {
  assert.deepEqual(SIGNAL_RANK, { green: 0, yellow: 1, red: 2 });
  assert.equal(worstSignal('green', 'yellow'), 'yellow');
  assert.equal(worstSignal('yellow', 'green'), 'yellow');
  assert.equal(worstSignal('red', 'yellow'), 'red');
  assert.equal(worstSignal('green', 'green'), 'green');
});
