import { expect, test } from 'vitest';
import { type SideLine, sideAgainstBase } from '@/lib/update-diff';

const marked = (lines: SideLine[]): string[] => lines.map((line) => `${line.mark}${line.text}`);

test('identical sides are all shared lines (#325)', () => {
  expect(marked(sideAgainstBase(['## Index', 'a'], ['## Index', 'a']))).toEqual([' ## Index', ' a']);
});

test('a changed line reads − then +, between the shared lines around it (#325)', () => {
  expect(marked(sideAgainstBase(['a', 'x', 'c'], ['a', 'y', 'c']))).toEqual([' a', '−x', '+y', ' c']);
  expect(marked(sideAgainstBase(['x1', 'x2'], ['y1', 'y2']))).toEqual(['−x1', '−x2', '+y1', '+y2']); // removals before additions within a gap
});

test('a removed line and an added line around shared ones keep reading order (#325)', () => {
  expect(marked(sideAgainstBase(['a', 'b', 'c'], ['a', 'c', 'd']))).toEqual([' a', '−b', ' c', '+d']);
});

test('an empty base is all added; an empty side is all removed (#325)', () => {
  expect(marked(sideAgainstBase([], ['a', 'b']))).toEqual(['+a', '+b']);
  expect(marked(sideAgainstBase(['a', 'b'], []))).toEqual(['−a', '−b']);
  expect(sideAgainstBase([], [])).toEqual([]);
});
