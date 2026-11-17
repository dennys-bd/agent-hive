import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as TestAffected from '../scripts/test-affected.mjs';
import { tempDir } from './temp-dir.js';

// .mjs files are not copied to dist/: this file, run from dist/test/, climbs back to the repo's scripts/ (#624).
const SCRIPT = new URL('../../scripts/test-affected.mjs', import.meta.url);
const { selectTests, changedFiles, workers }: typeof TestAffected = await import(SCRIPT.href);

// A repo with a dist/-shaped tree: a.test reaches c through b, d.test imports only a type (erased by tsc), e.test reads a repo file by URL.
const TREE: Record<string, string> = {
  'dist/test/a.test.js': "import { b } from '../src/b.js';\n",
  'dist/src/b.js': "export { c } from './c.js';\n",
  'dist/src/c.js': 'export const c = 1;\n',
  'dist/test/d.test.js': "import assert from 'node:assert/strict';\n",
  'dist/test/e.test.js': "const t = await import('./helper.js');\nconst f = new URL('../../src/template.ts', import.meta.url);\n",
  'dist/test/helper.js': 'export {};\n',
  // a tree guard: it reads src/ with readdir, so it imports nothing it checks
  'dist/test/temp-dir.test.js': 'export {};\n',
};

async function repo(t: TestContext): Promise<{ repo: string; root: string }> {
  const dir = await tempDir(t, 'affected-');
  for (const [file, body] of Object.entries(TREE)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  return { repo: dir, root: join(dir, 'dist') };
}

test('a changed module selects its direct and indirect importers only (#867)', async (t) => {
  const paths = await repo(t);
  assert.deepEqual(selectTests({ ...paths, changed: ['src/c.ts'] }), { files: ['test/a.test.js', 'test/temp-dir.test.js'] });
});

test('a changed test file selects itself (#867)', async (t) => {
  const paths = await repo(t);
  assert.deepEqual(selectTests({ ...paths, changed: ['test/d.test.ts'] }), { files: ['test/d.test.js', 'test/temp-dir.test.js'] });
});

test('a dynamic import and a file read through new URL count as edges (#867)', async (t) => {
  const paths = await repo(t);
  assert.deepEqual(selectTests({ ...paths, changed: ['test/helper.ts'] }), { files: ['test/e.test.js', 'test/temp-dir.test.js'] });
  assert.deepEqual(selectTests({ ...paths, changed: ['src/template.ts'] }), { files: ['test/e.test.js', 'test/temp-dir.test.js'] });
});

test('a changed file outside src/ and test/ that is not Markdown runs the whole suite (#867)', async (t) => {
  const paths = await repo(t);
  assert.deepEqual(selectTests({ ...paths, changed: ['src/c.ts', 'assets/plugin/x.md.liquid'] }), { full: 'assets/plugin/x.md.liquid' });
});

test('a Markdown file under assets/ runs the whole suite: the plugin tests read it (#867)', async (t) => {
  const paths = await repo(t);
  assert.deepEqual(selectTests({ ...paths, changed: ['assets/plugin/agents/planner.md'] }), { full: 'assets/plugin/agents/planner.md' });
});

test('a Markdown-only change selects nothing (#867)', async (t) => {
  const paths = await repo(t);
  assert.deepEqual(selectTests({ ...paths, changed: ['CLAUDE.md', 'docs/notes.md'] }), { files: [] });
});

test('changedFiles joins the diff against the merge-base with the untracked files, raw and deduplicated (#867)', () => {
  const calls: string[][] = [];
  const git = (args: readonly string[]): string => {
    calls.push([...args]);
    if (args[0] === 'merge-base') return 'abc123\n';
    if (args[0] === 'diff') return 'src/a.ts\0src/caf\u00e9 b.ts\0';
    return 'src/caf\u00e9 b.ts\0test/new.test.ts\0';
  };
  assert.deepEqual(changedFiles(git), { base: 'abc123', files: ['src/a.ts', 'src/caf\u00e9 b.ts', 'test/new.test.ts'] });
  assert.deepEqual(calls[0], ['merge-base', 'HEAD', 'origin/main']);
});

test('changedFiles answers no base when the merge-base cannot be resolved (#867)', () => {
  const git = (): string => {
    throw new Error('fatal: Not a valid object name origin/main');
  };
  assert.deepEqual(changedFiles(git), { base: null, files: [] });
});

test('workers is a quarter of the cores, never below one (#867)', () => {
  assert.equal(workers(12), 3);
  assert.equal(workers(2), 1);
  assert.equal(workers(1), 1);
});
