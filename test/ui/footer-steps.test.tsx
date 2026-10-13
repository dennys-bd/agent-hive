import { expect, test } from 'vitest';
import { LAST_STEP, nextStep, STEPS } from '@/lib/footer-steps';

test('the eight steps in handoff §6\'s order: each usage form first with the full rules, then the short ones (#227)', () => {
  expect(STEPS.map((s) => `${s.usage}/${s.rules}`)).toEqual([
    'full/full', 'full/short', 'compact/full', 'compact/short', 'minimal/full', 'minimal/short', 'group/full', 'group/short',
  ]);
  expect(LAST_STEP).toBe(7);
});

test('nextStep moves one step down on an overflow, stays without one, and never passes the last step (#227)', () => {
  expect(nextStep(0, true)).toBe(1);
  expect(nextStep(3, false)).toBe(3);
  expect(nextStep(LAST_STEP, true)).toBe(LAST_STEP);
});
