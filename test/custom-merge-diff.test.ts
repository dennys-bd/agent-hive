import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTexts, type Hunk } from '../src/custom-merge-git.js';
import { hunksAt, inBase, rowDiffs, spanOf } from '../src/custom-merge-diff.js';
import type { DiffHunk, DiffLine } from '../src/types.js';
import { tempDir } from './temp-dir.js';

const bytes = (text: string): Buffer => Buffer.from(text);
const hunk = (fromAbove: number, toAbove: number, removed: string[], added: string[]): Hunk => ({ fromAbove, toAbove, removed, added });
const headed = (header: string): DiffHunk => ({ header, lines: [] });
const ctx = (text: string, old: number, now = old): DiffLine => ({ kind: 'context', text, old, new: now });
const del = (text: string, old: number): DiffLine => ({ kind: 'del', text, old });
const add = (text: string, now: number): DiffLine => ({ kind: 'add', text, new: now });
// git may follow a -U1 header with a function line of its own choosing; the numbers are in the lines
const linesOf = (diffs: DiffHunk[][]): DiffLine[][][] => diffs.map((diff) => diff.map((h) => h.lines));

test('spanOf: a passage spans its removed lines; a pure insertion spans the line on each side of its point (#984)', () => {
  assert.deepEqual(spanOf({ fromAbove: 17, removed: ['A PR.'] }), { start: 18, end: 18 });
  assert.deepEqual(spanOf({ fromAbove: 4, removed: ['a', 'b'] }), { start: 5, end: 6 });
  assert.deepEqual(spanOf({ fromAbove: 9, removed: [] }), { start: 9, end: 10 });
  assert.deepEqual(spanOf({ fromAbove: 0, removed: [] }), { start: 0, end: 1 });
});

test("inBase shifts a passage by the user's edits that end at or above it, and only those (#984)", () => {
  const insertedAfter9 = hunk(9, 9, [], ['And its title.']); // base → mine: `@@ -9,0 +10 @@`
  assert.deepEqual(inBase({ fromAbove: 18, removed: ['A PR.'] }, [insertedAfter9]), { fromAbove: 17, removed: ['A PR.'] });
  assert.deepEqual(inBase({ fromAbove: 10, removed: ['x'] }, [insertedAfter9]), { fromAbove: 9, removed: ['x'] }, 'right below the edit');
  assert.deepEqual(inBase({ fromAbove: 5, removed: ['x'] }, [insertedAfter9]), { fromAbove: 5, removed: ['x'] }, 'above the edit');
  const removed3and4 = hunk(2, 2, ['c', 'd'], []); // `@@ -3,2 +2,0 @@`
  assert.deepEqual(inBase({ fromAbove: 6, removed: [] }, [removed3and4]), { fromAbove: 8, removed: [] });
  const oneIntoThree = hunk(0, 0, ['a'], ['a1', 'a2', 'a3']); // `@@ -1 +1,3 @@`
  assert.deepEqual(inBase({ fromAbove: 5, removed: ['e'] }, [oneIntoThree, insertedAfter9]), { fromAbove: 3, removed: ['e'] }, 'the edit below is not counted');
});

test("hunksAt keeps the hunks whose old side meets the span: a header's range, its count of 1 when left out, an empty old text's point (#984)", () => {
  const input = headed('@@ -8,3 +8,3 @@');
  const output = headed('@@ -17,2 +17,2 @@ Step two.');
  assert.deepEqual(hunksAt({ start: 18, end: 18 }, [input, output]), [output]);
  assert.deepEqual(hunksAt({ start: 9, end: 9 }, [input, output]), [input]);
  assert.deepEqual(hunksAt({ start: 12, end: 13 }, [input, output]), []);
  assert.equal(hunksAt({ start: 9, end: 10 }, [headed('@@ -9,2 +9,3 @@')]).length, 1, 'an insertion after line 9');
  assert.equal(hunksAt({ start: 0, end: 1 }, [headed('@@ -0,0 +1,2 @@')]).length, 1, 'an added file');
  assert.equal(hunksAt({ start: 1, end: 1 }, [headed('@@ -1 +0,0 @@')]).length, 1, 'a deleted one-line file');
  assert.deepEqual(hunksAt({ start: 2, end: 2 }, [headed('@@ -1 +0,0 @@')]), []);
});

const BASE = 'a\nb\nc\nd\ne\nf\n';
const HIVE = 'a\nB\nc\nd\ne\nF\n'; // two shipped changes far enough apart for git to keep two -U1 hunks
const SHIPPED = [[[ctx('a', 1), del('b', 2), add('B', 2), ctx('c', 3)]], [[ctx('e', 5), del('f', 6), add('F', 6)]]];

test("rowDiffs gives each row the shipped hunk at its passage, in base's numbers even below the user's own edit (#984)", async (t) => {
  const dir = await tempDir(t, 'merge-diff-');
  const untouched = { mine: bytes(BASE), base: bytes(BASE), hive: bytes(HIVE), result: bytes(HIVE) };
  assert.deepEqual(linesOf(await rowDiffs(dir, untouched, await diffTexts(dir, untouched.mine, untouched.result))), SHIPPED);
  const edited = { mine: bytes(`top\n${BASE}`), base: bytes(BASE), hive: bytes(HIVE), result: bytes(`top\n${HIVE}`) };
  assert.deepEqual(linesOf(await rowDiffs(dir, edited, await diffTexts(dir, edited.mine, edited.result))), SHIPPED);
  assert.deepEqual(await rowDiffs(dir, untouched, []), []);
});

test("rowDiffs falls back to the user's own diff to the result, at the row's lines, when no shipped hunk meets it (#984)", async (t) => {
  const dir = await tempDir(t, 'merge-diff-');
  const texts = { mine: bytes('a\nb\n'), base: bytes('a\nb\n'), hive: bytes('a\nb\n'), result: bytes('a\nB\n') };
  assert.deepEqual(linesOf(await rowDiffs(dir, texts, await diffTexts(dir, texts.mine, texts.result))), [[[ctx('a', 1), del('b', 2), add('B', 2)]]]);
});
