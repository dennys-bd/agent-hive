import { expect, test } from 'vitest';
import type { DiffHunk, DiffLine } from '../../src/types';
import { diffLineNumber, diffRange, type SideLine, sideAgainstBase } from '@/lib/update-diff';

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

const hunk = (lines: DiffLine[]): DiffHunk => ({ header: '@@', lines });

test("diffRange spans the hunks' first to last new-side number, the old side when they only remove, none without lines (#984)", () => {
  expect(diffRange([hunk([{ kind: 'context', text: '## Input', old: 8, new: 8 }, { kind: 'del', text: 'a', old: 9 }, { kind: 'add', text: 'b', new: 9 }, { kind: 'context', text: '', old: 10, new: 10 }])])).toEqual({ start: 8, end: 10 });
  expect(diffRange([hunk([{ kind: 'add', text: 'x', new: 3 }]), hunk([{ kind: 'context', text: 'y', old: 20, new: 22 }, { kind: 'add', text: 'z', new: 23 }])])).toEqual({ start: 3, end: 23 });
  expect(diffRange([hunk([{ kind: 'del', text: 'a', old: 1 }, { kind: 'del', text: 'b', old: 2 }])])).toEqual({ start: 1, end: 2 });
  expect(diffRange([])).toBeUndefined();
});

test('diffLineNumber is the old number on a removed line and the new one otherwise (#984)', () => {
  expect(diffLineNumber({ kind: 'del', text: 'a', old: 9 })).toBe(9);
  expect(diffLineNumber({ kind: 'add', text: 'b', new: 12 })).toBe(12);
  expect(diffLineNumber({ kind: 'context', text: 'c', old: 10, new: 11 })).toBe(11);
});
