import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturedCwd } from '../src/terminal-runs.js';

test('capturedCwd keeps an absolute folder on one line inside the terminal\'s own, and nothing else (#932)', () => {
  assert.deepEqual(
    ['/r', '/r/src', '/r/..x', '/elsewhere', '/r/../x', 'src', '/r/a\nb', 42].map((value) => capturedCwd(value, '/r')),
    ['/r', '/r/src', '/r/..x', undefined, undefined, undefined, undefined, undefined],
  );
  assert.deepEqual([capturedCwd('/r', undefined), capturedCwd('/r', '')], [undefined, undefined]);
});
