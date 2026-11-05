import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as TestNode from '../scripts/test-node.mjs';
import { tempDir } from './temp-dir.js';

// .mjs files are not copied to dist/: this file, run from dist/test/, climbs back to the repo's scripts/ (#624).
const RUNNER = new URL('../../scripts/test-node.mjs', import.meta.url);
const { testFiles }: typeof TestNode = await import(RUNNER.href);

// A dist/-shaped tree: test files under the globs, a helper that is not a test, and a file outside every glob.
const TREE = ['test/b.test.js', 'test/a.test.js', 'test/helpers.js', 'test/agents/c.test.js', 'test/benchmark/d.test.js', 'test/fixtures/runner/e.js'];

async function distRoot(t: TestContext, files: readonly string[] = TREE): Promise<string> {
  const root = await tempDir(t, 'runner-');
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  return root;
}

async function listFile(t: TestContext, text: string): Promise<string> {
  const file = join(await tempDir(t, 'runner-list-'), 'lane.txt');
  writeFileSync(file, text);
  return file;
}

test('testFiles picks what the globs match under dist/, sorted, and skips a file that is not a test (#624)', async (t) => {
  const root = await distRoot(t);
  assert.deepEqual(testFiles({ root }), ['test/a.test.js', 'test/agents/c.test.js', 'test/b.test.js', 'test/benchmark/d.test.js']);
});

test('a list replaces the globs and skips blank and # lines (#624)', async (t) => {
  const root = await distRoot(t);
  const list = await listFile(t, '# the lane\n\ntest/fixtures/runner/e.js\r\ntest/b.test.js\n   \n');
  assert.deepEqual(testFiles({ root, list }), ['test/b.test.js', 'test/fixtures/runner/e.js']);
});

test('a listed path missing under dist/ fails the selection (#624)', async (t) => {
  const root = await distRoot(t);
  const list = await listFile(t, 'test/b.test.js\ntest/gone.test.js\n');
  assert.throws(() => testFiles({ root, list }), /test\/gone\.test\.js/);
});

test('--exclude drops matching paths from the globs and from a list (#624)', async (t) => {
  const root = await distRoot(t);
  assert.deepEqual(testFiles({ root, exclude: ['test/benchmark/**'] }), ['test/a.test.js', 'test/agents/c.test.js', 'test/b.test.js']);
  const list = await listFile(t, 'test/b.test.js\ntest/fixtures/runner/e.js\n');
  assert.deepEqual(testFiles({ root, list, exclude: ['test/b.test.js'] }), ['test/fixtures/runner/e.js']);
});

test('a selection with no file fails instead of passing green (#624)', async (t) => {
  const noTests = await distRoot(t, ['test/helpers.js']);
  assert.throws(() => testFiles({ root: noTests }), /no test file selected/);
  const root = await distRoot(t);
  assert.throws(() => testFiles({ root, exclude: ['test/**'] }), /no test file selected/);
});
