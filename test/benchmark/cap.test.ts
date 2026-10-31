import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capReached, experimentTokens, highestPercent } from '../../src/benchmark/cap.js';
import { noMetrics } from '../../src/benchmark/metrics.js';
import type { BenchMetrics, Experiment, PlanReadings } from '../../src/types.js';
import { experiment, run } from './fixtures.js';

const AT = '2026-10-22T22:00:00.000Z';
const NOW = Date.parse(AT); // before every window's reset
const spent = (tokens: number): BenchMetrics => ({ ...noMetrics(), tokens });
const SPENT = experiment({ rounds: [
  { n: 1, runs: [run('aaaa1', { status: 'done', metrics: spent(1_000) }), run('aaaa2', { armId: 'a2', status: 'interrupted', metrics: spent(300) })] },
  { n: 2, runs: [run('bbbb1', { round: 2, status: 'running', metrics: spent(200) }), run('bbbb2', { round: 2, armId: 'a2', status: 'running' })] },
] });
const window = (usedPercent: number) => ({ usedPercent, resetsAt: '2026-10-23T00:00:00.000Z' });
const READINGS: PlanReadings = {
  claude: { at: AT, windows: { five_hour: window(40), seven_day: window(72) } },
  codex: { at: AT, windows: { primary: window(55) } },
};
const capped = (cap: Experiment['pace']['cap']): Experiment => ({ ...SPENT, pace: { ...SPENT.pace, cap } });

test("experimentTokens sums every run of every round: an ended run's metrics, a running one's last read, an interrupted one's spend (#472)", () => {
  assert.equal(experimentTokens(SPENT), 1_500);
  assert.equal(experimentTokens(experiment()), 0);
});

test("highestPercent is the highest window of every agent's latest reading; no reading or no window is undefined (#472)", () => {
  assert.equal(highestPercent(READINGS, NOW), 72);
  assert.equal(highestPercent(undefined, NOW), undefined);
  assert.equal(highestPercent({}, NOW), undefined);
  assert.equal(highestPercent({ claude: { at: AT, windows: {} } }, NOW), undefined);
});

test('capReached once the tokens pass cap.tokens or the highest window passes cap.planPercent; at the cap, with no reading or no cap, never (#472)', () => {
  assert.equal(capReached(capped({ tokens: 1_499 }), undefined, NOW), true);
  assert.equal(capReached(capped({ tokens: 1_500 }), undefined, NOW), false);
  assert.equal(capReached(capped({ planPercent: 70 }), READINGS, NOW), true);
  assert.equal(capReached(capped({ planPercent: 72 }), READINGS, NOW), false);
  assert.equal(capReached(capped({ planPercent: 10 }), undefined, NOW), false);
  assert.equal(capReached(capped({}), READINGS, NOW), false);
});

test('a window past its reset counts 0%, as the footer shows it: an idle account never holds the cap (#557)', () => {
  const later = Date.parse('2026-10-23T00:00:00.000Z'); // every window's reset, so every window is past
  assert.equal(highestPercent(READINGS, later), 0);
  assert.equal(capReached(capped({ planPercent: 70 }), READINGS, later), false);
});
