import { expect, test } from 'vitest';
import { fitCount } from '@/hooks/use-tweak-overflow';

test('every control fits: all of them, no room kept for the trigger (#342)', () => {
  expect(fitCount([40, 40, 40], 10, 140, 50)).toBe(3);
});

test('one no longer fits: the row keeps those that fit beside the trigger (#342)', () => {
  expect(fitCount([40, 40, 40], 10, 139, 50)).toBe(1);
  expect(fitCount([40, 40, 40], 10, 139, 30)).toBe(2);
});

test('no room at all: none stays in the row (#342)', () => {
  expect(fitCount([40], 0, 20, 50)).toBe(0);
});
