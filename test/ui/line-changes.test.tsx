import { expect, test } from 'vitest';
import { lineChanges } from '@/lib/line-changes';

const BASE = 'a\nb\nc';

test('identical texts have no change; an empty base makes every line added, an empty file over an empty base none (#668)', () => {
  expect(lineChanges('a\nb\n', 'a\nb\n')).toEqual([]);
  expect(lineChanges('', 'a\nb')).toEqual([{ kind: 'add', start: 1, end: 3, baseStart: 1, baseEnd: 1 }]);
  expect(lineChanges('', '')).toEqual([]);
});

test('an added line at the start, the middle and the end spans its own lines and none of the base (#668)', () => {
  expect(lineChanges(BASE, 'x\na\nb\nc')).toEqual([{ kind: 'add', start: 1, end: 2, baseStart: 1, baseEnd: 1 }]);
  expect(lineChanges(BASE, 'a\nx\nb\nc')).toEqual([{ kind: 'add', start: 2, end: 3, baseStart: 2, baseEnd: 2 }]);
  expect(lineChanges(BASE, 'a\nb\nc\nx')).toEqual([{ kind: 'add', start: 4, end: 5, baseStart: 4, baseEnd: 4 }]);
});

test('a changed line at the start, the middle and the end is modified, over the base line it replaces (#668)', () => {
  expect(lineChanges(BASE, 'A\nb\nc')).toEqual([{ kind: 'modify', start: 1, end: 2, baseStart: 1, baseEnd: 2 }]);
  expect(lineChanges(BASE, 'a\nB\nc')).toEqual([{ kind: 'modify', start: 2, end: 3, baseStart: 2, baseEnd: 3 }]);
  expect(lineChanges(BASE, 'a\nb\nC')).toEqual([{ kind: 'modify', start: 3, end: 4, baseStart: 3, baseEnd: 4 }]);
});

test('a deleted line at the start, the middle and the end sits before the line after it, over the base line it took (#668)', () => {
  expect(lineChanges(BASE, 'b\nc')).toEqual([{ kind: 'delete', start: 1, end: 1, baseStart: 1, baseEnd: 2 }]);
  expect(lineChanges(BASE, 'a\nc')).toEqual([{ kind: 'delete', start: 2, end: 2, baseStart: 2, baseEnd: 3 }]);
  expect(lineChanges(BASE, 'a\nb')).toEqual([{ kind: 'delete', start: 3, end: 3, baseStart: 3, baseEnd: 4 }]);
});

test('several changes of one file come in order, CRLF read as a line break (#668)', () => {
  expect(lineChanges('a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng', 'a\nB\nc\nd\nf\ng\nh')).toEqual([
    { kind: 'modify', start: 2, end: 3, baseStart: 2, baseEnd: 3 },
    { kind: 'delete', start: 5, end: 5, baseStart: 5, baseEnd: 6 },
    { kind: 'add', start: 7, end: 8, baseStart: 8, baseEnd: 8 },
  ]);
});
