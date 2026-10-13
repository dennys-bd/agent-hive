import { expect, test } from 'vitest';
import { countsOf, hunkContext, splitPath, splitRows } from '@/lib/diff-rows';
import type { DiffHunk, DiffLine } from '../../src/types';

const ctx = (o: number, n: number, text: string): DiffLine => ({ kind: 'context', text, old: o, new: n });
const del = (o: number, text: string): DiffLine => ({ kind: 'del', text, old: o });
const add = (n: number, text: string): DiffLine => ({ kind: 'add', text, new: n });
const hunk = (...lines: DiffLine[]): DiffHunk => ({ header: '@@ -1 +1 @@', lines });
const texts = (h: DiffHunk): [string, string][] => splitRows(h).map((r) => [r.old?.text ?? '', r.new?.text ?? '']);

test('splitRows pairs a deleted run with the added run after it row by row; context sits on both sides (#591)', () => {
  expect(texts(hunk(ctx(1, 1, 'a'), del(2, 'b'), del(3, 'c'), add(2, 'B'), add(3, 'C'), ctx(4, 4, 'd'))))
    .toEqual([['a', 'a'], ['b', 'B'], ['c', 'C'], ['d', 'd']]);
});

test('splitRows leaves empty cells on the shorter side: a longer deleted run, a longer added run, adds with no deletes (#591)', () => {
  expect(texts(hunk(del(1, 'x'), del(2, 'y'), add(1, 'X')))).toEqual([['x', 'X'], ['y', '']]);
  expect(texts(hunk(del(1, 'x'), add(1, 'X'), add(2, 'Y')))).toEqual([['x', 'X'], ['', 'Y']]);
  expect(texts(hunk(add(1, 'X'), del(1, 'x')))).toEqual([['', 'X'], ['x', '']]);
});

test('countsOf adds and deletes across hunks (#591)', () => {
  expect(countsOf([hunk(del(1, 'x'), add(1, 'X')), hunk(add(5, 'Y'))])).toEqual({ add: 2, del: 1 });
});

test('hunkContext keeps the function git printed after the range, and the whole header when there is none; splitPath splits folder and name (#853)', () => {
  expect(hunkContext('@@ -181,7 +181,7 @@ function withBefore(a) {')).toBe('function withBefore(a) {');
  expect(hunkContext('@@ -1,2 +1,2 @@ intro')).toBe('intro');
  expect(hunkContext('@@ -1 +1 @@')).toBe('@@ -1 +1 @@');
  expect(hunkContext('@@ -1 +1 @@   ')).toBe('@@ -1 +1 @@   ');
  expect(splitPath('src/ui/a.ts')).toEqual({ dir: 'src/ui/', name: 'a.ts' });
  expect(splitPath('a.ts')).toEqual({ dir: '', name: 'a.ts' });
});
