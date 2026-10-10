import { expect, test } from 'vitest';
import { type DragRow, dropTarget, isNoOpTarget, toIndex } from '@/components/tab-drag';

// Three stacked 30px rows, their midpoints at 15, 45 and 75: the session list as useTabDrag reads it (#440)
const row = (key: string, top: number): DragRow => ({ key, rect: { top, bottom: top + 30 } as DOMRect });
const ROWS = [row('A', 0), row('B', 30), row('C', 60)];
const KEYS = ['A', 'B', 'C'];

test('dropTarget names the first row whose midpoint is below the pointer, the dragged one included, and the end past every midpoint (#440)', () => {
  expect([0, 14, 16, 44, 46, 74].map((y) => dropTarget(ROWS, y))).toEqual(['A', 'A', 'B', 'B', 'C', 'C']);
  expect([76, 500].map((y) => dropTarget(ROWS, y))).toEqual(['end', 'end']);
  expect(dropTarget([], 10)).toBe('end');
});

test('isNoOpTarget: before itself, before the entry right after it, or the end when already last moves nothing; any other gap moves it (#440)', () => {
  expect([isNoOpTarget('B', 'B', KEYS), isNoOpTarget('C', 'B', KEYS), isNoOpTarget('end', 'C', KEYS)]).toEqual([true, true, true]);
  expect([isNoOpTarget('A', 'B', KEYS), isNoOpTarget('end', 'B', KEYS), isNoOpTarget('C', 'A', KEYS)]).toEqual([false, false, false]);
});

test("toIndex gives moveTab the target's index in the list without the dragged key, or that list's length for the end (#440)", () => {
  expect(toIndex('A', 'C', KEYS)).toBe(0); // up: C lands before A
  expect(toIndex('C', 'A', KEYS)).toBe(1); // down: A lands before C, in [B, C]
  expect(toIndex('end', 'A', KEYS)).toBe(2);
});

test('dropTarget reads the midpoints across, along x, for a center tab strip (#458)', () => {
  const tabs: DragRow[] = [{ key: 'A', rect: { left: 0, right: 100 } as DOMRect }, { key: 'B', rect: { left: 100, right: 200 } as DOMRect }];
  expect([40, 60, 140, 160].map((x) => dropTarget(tabs, x, 'x'))).toEqual(['A', 'B', 'B', 'end']);
});
