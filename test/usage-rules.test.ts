import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, HOUR_MS } from '../src/usage.js';
import { activeRules, applyUsageRules, copyDisabledRule, disableExpired, firedRules, isDisabledRule, isGlobalRule, PLAN_WINDOW, rollingBackAt, ruleBackAt, SIGNAL_RANK, sourcePercents, stageCapRules, stageCaps, worstSignal } from '../src/usage-rules.js';
import type { Budget, DisabledRule, RateLimits, RuleSource, Stage, UsageRule, UsageSample } from '../src/types.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const FUTURE = '2026-09-16T15:00:00.000Z';
const HOUR = 2_000_000;
const DAY = 20_000_000;
const BUDGET: Budget = { maxTokensPerHour: HOUR, maxTokensPerDay: DAY };
// the spec's config example
const RULES: UsageRule[] = [
  { source: 'day', percent: 50, maxWorkers: 3 },
  { source: 'hour', percent: 80, signal: 'yellow' },
  { source: 'session', percent: 80, maxWorkers: 1, signal: 'yellow' },
  { source: 'week', percent: 90, signal: 'red' },
];
const NONE: Record<RuleSource, number> = { hour: 0, day: 0, session: 0, week: 0, month: 0 };
// one sample `ageMs` before NOW
const sample = (tokens: number, ageMs = 0): UsageSample => ({ at: new Date(NOW - ageMs).toISOString(), tokens });
const hourAt = (percent: number): UsageSample[] => [sample((HOUR / 100) * percent)];
const budget = (usage: UsageSample[], b: Budget = BUDGET): [number, number] => {
  const { hour, day } = sourcePercents(usage, b, undefined, NOW);
  return [hour, day];
};
// a reading with the given windows; a missing one is left out of the map
const windows = (fiveHour?: number, sevenDay?: number, resetsAt = FUTURE): RateLimits => ({
  at: '2026-09-16T11:55:00.000Z',
  windows: {
    ...(fiveHour === undefined ? {} : { five_hour: { usedPercent: fiveHour, resetsAt } }),
    ...(sevenDay === undefined ? {} : { seven_day: { usedPercent: sevenDay, resetsAt } }),
  },
});
const at = (percents: Partial<Record<RuleSource, number>>) => applyUsageRules({ ...NONE, ...percents }, RULES);
const MINUTE = 60_000;

test('sourcePercents reads hour and day as the share of the budget: 0 without samples, without a limit or with a zero limit', () => {
  assert.deepEqual(sourcePercents([], BUDGET, undefined, NOW), NONE);
  assert.deepEqual(sourcePercents(hourAt(50), {}, undefined, NOW), NONE, 'a budget with no window set');
  assert.deepEqual(sourcePercents(hourAt(50), { maxTokensPerHour: 0 }, undefined, NOW), NONE, 'a zero limit is no limit, never a division by zero');
});

test('sourcePercents keeps hour and day apart, each over its own limit, and reads above 100 over budget', () => {
  assert.deepEqual(budget([sample(1_000_000)]), [50, 5]);
  assert.deepEqual(budget([sample(15_000_000, 2 * HOUR_MS)]), [0, 75], 'older than an hour: counts for the day only');
  assert.deepEqual(budget([sample(1_000_000), sample(14_000_000, 2 * HOUR_MS)]), [50, 75], 'no longer folded into one worst number');
  assert.deepEqual(budget([sample(100), sample(15_000_000, 2 * HOUR_MS)], { maxTokensPerHour: 1000 }), [10, 0], 'day reads 0 without a day limit');
  assert.deepEqual(budget([sample(3_000_000)]), [150, 15], 'over budget reads above 100');
  assert.equal(budget([sample(1_140_000)])[0], 57, 'exact share reads exactly, no float drift');
});

test('sourcePercents reads session and week from the plan windows; absent rateLimits, absent window or a reset already passed read 0; other windows are ignored', () => {
  assert.deepEqual(PLAN_WINDOW, { session: 'five_hour', week: 'seven_day', month: 'thirty_day' });
  const thirty: RateLimits = { at: FUTURE, windows: { thirty_day: { usedPercent: 40, resetsAt: FUTURE } } };
  assert.deepEqual(sourcePercents([], BUDGET, thirty, NOW), { ...NONE, month: 40 }, 'month reads thirty_day (#929)');
  assert.deepEqual(sourcePercents([], BUDGET, windows(85, 41), NOW), { ...NONE, session: 85, week: 41 });
  assert.deepEqual(sourcePercents([], BUDGET, windows(85), NOW), { ...NONE, session: 85 }, 'no seven_day: week reads 0');
  assert.deepEqual(sourcePercents([], BUDGET, windows(85, 41, '2026-09-16T12:00:00.000Z'), NOW), NONE, 'resetsAt == now: the window has reset even if the reader has not caught up');
  assert.deepEqual(sourcePercents([], BUDGET, windows(85, 41, '2026-09-16T11:00:00.000Z'), NOW), NONE, 'resetsAt < now');
  const opus: RateLimits = { at: FUTURE, windows: { seven_day_opus: { usedPercent: 99, resetsAt: FUTURE } } };
  assert.deepEqual(sourcePercents(hourAt(50), BUDGET, opus, NOW), { ...NONE, hour: 50, day: 5 }, 'per-model windows are display-only; budget sources read as usual');
});

test('applyUsageRules fires every rule whose source is at or above its percent (the floor included); worst signal and smallest cap win across sources', () => {
  assert.deepEqual(at({}), { signal: 'green' });
  assert.deepEqual(at({ day: 49 }), { signal: 'green' });
  assert.deepEqual(at({ day: 50 }), { signal: 'green', maxWorkers: 3 }, 'the floor fires');
  assert.deepEqual(at({ hour: 80 }), { signal: 'yellow' }, 'an hour rule ignores the day share');
  assert.deepEqual(at({ session: 85 }), { signal: 'yellow', maxWorkers: 1 });
  assert.deepEqual(applyUsageRules(sourcePercents([], BUDGET, windows(85), NOW), RULES), { signal: 'yellow', maxWorkers: 1 }, 'a session rule fires from the reading alone, with no usage samples');
  assert.deepEqual(at({ day: 55, session: 85 }), { signal: 'yellow', maxWorkers: 1 }, 'smallest cap across sources');
  assert.deepEqual(at({ day: 55, hour: 80, week: 90 }), { signal: 'red', maxWorkers: 3 }, 'worst signal across sources');
  assert.deepEqual(at({ hour: 150, day: 150, session: 100, week: 100 }), { signal: 'red', maxWorkers: 1 });
});

test('applyUsageRules ignores array order, adds no maxWorkers key for a signal-only rule, and is green without rules or data', () => {
  const all = { ...NONE, hour: 95, session: 95 };
  assert.deepEqual(applyUsageRules(all, [...RULES].reverse()), applyUsageRules(all, RULES));
  assert.deepEqual(applyUsageRules({ ...NONE, hour: 85 }, [RULES[1]]), { signal: 'yellow' });
  assert.deepEqual(applyUsageRules(NONE, RULES), { signal: 'green' });
  assert.deepEqual(applyUsageRules(all, []), { signal: 'green' });
  assert.deepEqual(applyUsageRules(sourcePercents(hourAt(95), {}, undefined, NOW), RULES), { signal: 'green' }, 'no budget: the budget sources read 0');
});

test('firedRules keeps the rules at or above their percent, in array order, unfiltered by signal; applyUsageRules is unaffected', () => {
  assert.deepEqual(firedRules(NONE, RULES), []);
  assert.deepEqual(firedRules({ ...NONE, day: 50 }, RULES), [RULES[0]]);
  assert.deepEqual(firedRules({ ...NONE, day: 55, hour: 80, week: 90 }, RULES), [RULES[0], RULES[1], RULES[3]], 'order preserved');
  assert.deepEqual(applyUsageRules({ ...NONE, day: 55, session: 85 }, RULES), { signal: 'yellow', maxWorkers: 1 }, 'still the same answer');
});

test('worstSignal ranks green < yellow < red', () => {
  assert.deepEqual(SIGNAL_RANK, { green: 0, yellow: 1, red: 2 });
  assert.equal(worstSignal('green', 'yellow'), 'yellow');
  assert.equal(worstSignal('yellow', 'green'), 'yellow');
  assert.equal(worstSignal('red', 'yellow'), 'red');
  assert.equal(worstSignal('green', 'green'), 'green');
});

test('activeRules leaves out only the rules whose source and percent a disable names (#297)', () => {
  const disabled: DisabledRule[] = [{ source: 'hour', percent: 80, until: { kind: 'reset' } }, { source: 'week', percent: 80, until: { kind: 'manual' } }];
  assert.deepEqual(activeRules(RULES, disabled), [RULES[0], RULES[2], RULES[3]], 'week 80 names no rule: the table has week 90');
  assert.deepEqual(activeRules(RULES, []), RULES);
});

test('rollingBackAt is when the sample whose leaving brings the window below the percent ages out; undefined without a limit (#297)', () => {
  const usage = [sample(600_000, 50 * MINUTE), sample(600_000, 30 * MINUTE), sample(600_000, 10 * MINUTE)]; // 1.8M of 2M in the hour: 90%
  const out = (ageMs: number): string => new Date(NOW - ageMs + HOUR_MS).toISOString();
  assert.equal(rollingBackAt(usage, HOUR_MS, HOUR, 80, NOW), out(50 * MINUTE), 'the oldest leaving takes it to 60%');
  assert.equal(rollingBackAt(usage, HOUR_MS, HOUR, 40, NOW), out(30 * MINUTE), 'below 40% needs two to leave: 30%');
  assert.equal(rollingBackAt(usage, HOUR_MS, HOUR, 30, NOW), out(10 * MINUTE), 'exactly 30% is still at the percent: all three must leave');
  assert.equal(rollingBackAt([sample(1_000_000, 2 * HOUR_MS), ...usage], HOUR_MS, HOUR, 80, NOW), out(50 * MINUTE), 'a sample outside the window is not counted');
  assert.equal(rollingBackAt(usage, HOUR_MS, undefined, 80, NOW), undefined);
  assert.equal(rollingBackAt(usage, HOUR_MS, 0, 80, NOW), undefined, 'a zero limit is no limit');
});

test('ruleBackAt: a plan rule at its window\'s reset, a budget rule at its rolling estimate; disableExpired: reset below the percent, at from its time, manual never (#297)', () => {
  const state = { usage: [sample(1_800_000, 50 * MINUTE)], budget: BUDGET, rateLimits: windows(85, 95) };
  assert.equal(ruleBackAt({ source: 'session', percent: 80 }, state, NOW), FUTURE);
  assert.equal(ruleBackAt({ source: 'week', percent: 90 }, state, NOW), FUTURE);
  assert.equal(ruleBackAt({ source: 'month', percent: 40 }, { ...state, rateLimits: { at: FUTURE, windows: { thirty_day: { usedPercent: 40, resetsAt: FUTURE } } } }, NOW), FUTURE);
  assert.equal(ruleBackAt({ source: 'session', percent: 80 }, { ...state, rateLimits: undefined }, NOW), undefined, 'no reading: no reset to show');
  assert.equal(ruleBackAt({ source: 'hour', percent: 80 }, state, NOW), new Date(NOW - 50 * MINUTE + HOUR_MS).toISOString());
  assert.equal(ruleBackAt({ source: 'day', percent: 5 }, state, NOW), new Date(NOW - 50 * MINUTE + DAY_MS).toISOString(), '1.8M of 20M: 9%');
  assert.equal(ruleBackAt({ source: 'hour', percent: 80 }, { ...state, budget: {} }, NOW), undefined, 'no hour limit');
  const percents: Record<RuleSource, number> = { ...NONE, session: 85 };
  assert.equal(disableExpired({ source: 'session', percent: 80, until: { kind: 'reset' } }, percents, NOW), false);
  assert.equal(disableExpired({ source: 'session', percent: 90, until: { kind: 'reset' } }, percents, NOW), true);
  assert.equal(disableExpired({ source: 'session', percent: 90, until: { kind: 'at', at: FUTURE } }, percents, NOW), false, 'below the percent, yet its time has not come');
  assert.equal(disableExpired({ source: 'session', percent: 80, until: { kind: 'at', at: '2026-09-16T12:00:00.000Z' } }, percents, NOW), true, 'at its time');
  assert.equal(disableExpired({ source: 'session', percent: 90, until: { kind: 'manual' } }, NONE, NOW), false);
});

test('a stage rule never reaches the global floor: applyUsageRules reads only the rules without a stage (#475)', () => {
  const staged: UsageRule = { source: 'week', percent: 70, maxWorkers: 1, stage: 'build' };
  assert.deepEqual(applyUsageRules({ ...NONE, week: 80 }, [staged]), { signal: 'green' });
  assert.deepEqual(applyUsageRules({ ...NONE, week: 80 }, [staged, { source: 'week', percent: 70, maxWorkers: 2 }]), { signal: 'green', maxWorkers: 2 });
  assert.deepEqual([isGlobalRule(staged), isGlobalRule(RULES[0])], [false, true]);
});

test('stageCaps takes, per stage, the smallest of its own maxWorkers and the fired rules naming it; stageCapRules lists the rules at that cap (#475)', () => {
  const PIPELINE: Stage[] = [{ name: 'spec', from: {} }, { name: 'build', from: {}, maxWorkers: 3 }, { name: 'review', from: {}, maxWorkers: 0 }];
  const build1: UsageRule = { source: 'week', percent: 70, maxWorkers: 1, stage: 'build' };
  const build2: UsageRule = { source: 'session', percent: 50, maxWorkers: 2, stage: 'build' };
  const spec4: UsageRule = { source: 'week', percent: 70, maxWorkers: 4, stage: 'spec' };
  const total: UsageRule = { source: 'week', percent: 50, maxWorkers: 0 };
  assert.deepEqual(stageCaps(PIPELINE, []), { build: 3, review: 0 }, 'the stages\' own caps, 0 included; spec has none');
  assert.deepEqual(stageCaps(PIPELINE, [build2, total, spec4]), { spec: 4, build: 2, review: 0 }, 'a rule under the stage cap wins; a global rule caps no stage');
  assert.deepEqual(stageCaps(PIPELINE, [build1, build2]), stageCaps(PIPELINE, [build2, build1]), 'order is irrelevant');
  assert.equal(stageCaps(PIPELINE, [build2, build1]).build, 1, 'the lowest cap wins');
  assert.equal(stageCaps(PIPELINE, [{ ...build1, maxWorkers: 5 }]).build, 3, 'a looser rule leaves the stage cap');
  assert.deepEqual(stageCapRules({ build: 1, review: 0 }, [build2, build1, total]), { build: [build1] }, 'only the rules at the cap; review\'s own cap has no rule behind it');
});

test('isDisabledRule accepts the three untils with a known source and a finite percent, an at only as toISOString writes it; copyDisabledRule keeps only those fields (#297)', () => {
  const at = '2026-09-16T15:00:00.000Z';
  for (const until of [{ kind: 'reset' }, { kind: 'manual' }, { kind: 'at', at }]) {
    assert.equal(isDisabledRule({ source: 'hour', percent: 80, until }), true, JSON.stringify(until));
  }
  const bad: unknown[] = [
    null, 'x', [], { source: 'year', percent: 80, until: { kind: 'reset' } }, { source: 'constructor', percent: 80, until: { kind: 'reset' } },
    { source: 'hour', percent: '80', until: { kind: 'reset' } }, { source: 'hour', percent: Number.NaN, until: { kind: 'reset' } }, { source: 'hour', percent: 80 },
    { source: 'hour', percent: 80, until: { kind: 'later' } }, { source: 'hour', percent: 80, until: { kind: 'at', at: 'soon' } },
    { source: 'hour', percent: 80, until: { kind: 'at', at: '2026-09-16' } }, { source: 'hour', percent: 80, until: { kind: 'at' } },
  ];
  for (const value of bad) assert.equal(isDisabledRule(value), false, JSON.stringify(value));
  const loose = { source: 'hour', percent: 80, until: { kind: 'at', at, extra: 1 }, extra: true } as unknown as DisabledRule;
  assert.deepEqual(copyDisabledRule(loose), { source: 'hour', percent: 80, until: { kind: 'at', at } });
});
