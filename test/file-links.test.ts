import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFileLinks } from '../src/ui/lib/file-links.js';

test('findFileLinks finds relative paths with a / or an extension and absolute ones, with :line and :line:col, and their span (#258)', () => {
  assert.deepEqual(findFileLinks('edit src/a.ts now'), [{ path: 'src/a.ts', start: 5, end: 13 }]);
  assert.deepEqual(findFileLinks('see docs/x.md:42.'), [{ path: 'docs/x.md', line: 42, start: 4, end: 16 }], 'the full stop stays outside');
  assert.deepEqual(findFileLinks('at /abs/p.ts:3:7'), [{ path: '/abs/p.ts', line: 3, col: 7, start: 3, end: 16 }]);
  assert.deepEqual(findFileLinks('(`src/b.tsx`)'), [{ path: 'src/b.tsx', start: 2, end: 11 }], 'quotes and brackets are not part of it');
  assert.deepEqual(findFileLinks('README.md and lib/'), [{ path: 'README.md', start: 0, end: 9 }], 'an extension is enough; a bare folder name is a word');
});

test('findFileLinks skips URLs, plain words, times and version numbers (#258)', () => {
  assert.deepEqual(findFileLinks('open https://github.com/acme/r/blob/main/src/a.ts or http://localhost:47821/x.md'), []);
  assert.deepEqual(findFileLinks('plain words, 12:30 and v1.2.3'), []);
});
