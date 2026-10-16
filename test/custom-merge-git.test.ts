import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTexts, MARKER_SIZE, mergeTexts, parseMerge, resolveMerge } from '../src/custom-merge-git.js';
import { tempDir } from './temp-dir.js';

const bytes = (text: string): Buffer => Buffer.from(text);

test('mergeTexts cuts the merge into merged lines and conflict blocks carrying mine, base and hive; resolveMerge picks a side per block (#324)', async (t) => {
  const dir = await tempDir(t, 'merge-git-');
  const segments = await mergeTexts(dir, bytes('a\nB1\nc\nd\nE\n'), bytes('a\nb\nc\nd\ne\n'), bytes('a\nB2\nc\nd\ne\n'));
  assert.deepEqual(segments, ['a\n', { mine: ['B1\n'], base: ['b\n'], hive: ['B2\n'] }, 'c\n', 'd\n', 'E\n']);
  assert.equal(resolveMerge(segments, () => 'mine'), 'a\nB1\nc\nd\nE\n');
  assert.equal(resolveMerge(segments, () => 'hive'), 'a\nB2\nc\nd\nE\n');
});

test('a clean merge keeps CRLF line endings and a missing final newline (#324)', async (t) => {
  const dir = await tempDir(t, 'merge-git-');
  const segments = await mergeTexts(dir, bytes('ONE\r\ntwo\r\nthree\r\nfour'), bytes('one\r\ntwo\r\nthree\r\nfour'), bytes('one\r\ntwo\r\nthree\r\nFOUR'));
  assert.equal(resolveMerge(segments, () => 'mine'), 'ONE\r\ntwo\r\nthree\r\nFOUR');
});

test('only markers of MARKER_SIZE open, split and close a block: a line of seven < or = is text (#324)', () => {
  const marker = (char: string, label = ''): string => `${char.repeat(MARKER_SIZE)}${label}\n`;
  const text = `<<<<<<< x\n=======\n${marker('<', ' mine')}m\n${marker('|', ' base')}b\n${marker('=')}h\n${marker('>', ' hive')}`;
  assert.deepEqual(parseMerge(text), ['<<<<<<< x\n', '=======\n', { mine: ['m\n'], base: ['b\n'], hive: ['h\n'] }]);
  assert.throws(() => parseMerge(`${marker('<', ' mine')}m\n`), /left a conflict open/);
});

test('diffTexts answers -U0 hunks with the lines above them on each side, and none for equal texts (#324)', async (t) => {
  const dir = await tempDir(t, 'merge-git-');
  assert.deepEqual(await diffTexts(dir, bytes('# T\nx\ny\n'), bytes('# T\nx\nY\nz\n')), [{ fromAbove: 2, toAbove: 2, removed: ['y'], added: ['Y', 'z'] }]);
  assert.deepEqual(await diffTexts(dir, bytes(''), bytes('n\r\n')), [{ fromAbove: 0, toAbove: 0, removed: [], added: ['n'] }]);
  assert.deepEqual(await diffTexts(dir, bytes('same\n'), bytes('same\n')), []);
});
