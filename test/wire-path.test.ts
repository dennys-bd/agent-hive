import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWire } from '../src/wire-path.js';

test('toWire on win32 turns every \\ into /, so the UI splits a relative path on / alone (#641)', () => {
  assert.equal(toWire('a\\b\\c.ts', 'win32'), 'a/b/c.ts');
  assert.equal(toWire('c.ts', 'win32'), 'c.ts');
  assert.equal(toWire('', 'win32'), '');
});

test('toWire anywhere else answers the path unchanged: on POSIX a \\ is a legal character of a name (#641)', () => {
  assert.equal(toWire('a/b/c.ts', 'darwin'), 'a/b/c.ts');
  assert.equal(toWire('a\\b', 'linux'), 'a\\b');
});
