import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TestWsl from '../scripts/test-wsl.mjs';
import { tempDir } from './temp-dir.js';

// .mjs files are not copied to dist/: this file, run from dist/test/, climbs back to the repo's scripts/ (#624, #948)
const RUNNER = new URL('../../scripts/test-wsl.mjs', import.meta.url);
const { wslFiles }: typeof TestWsl = await import(RUNNER.href);

const PASSING = "import { test } from 'node:test';\ntest('wsl lane probe', () => {});\n";
// A dist/-shaped tree: two lane tests, the lane's helper beside them, and a test of the other lanes
const TREE: Readonly<Record<string, string>> = {
  'test/wsl-real/b.test.js': PASSING, 'test/wsl-real/a.test.js': PASSING, 'test/wsl-real/real-wsl.js': '', 'test/a.test.js': PASSING,
};

async function distRoot(t: TestContext, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await tempDir(t, 'wsl-runner-');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

async function runLane(root: string, distro?: string): Promise<{ code: number | null; stderr: string }> {
  // inherited, NODE_TEST_CONTEXT would make the inner node --test report to this run instead of running; HIVE_WSL_DISTRO is the case's own
  const { NODE_TEST_CONTEXT: _runner, HIVE_WSL_DISTRO: _distro, ...env } = process.env;
  const child = spawn(process.execPath, [fileURLToPath(RUNNER), `--root=${root}`], {
    env: distro === undefined ? env : { ...env, HIVE_WSL_DISTRO: distro }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stderr };
}

test('wslFiles picks only test/wsl-real/*.test.js, sorted, never the helper beside them or a test of another lane (#948)', async (t) => {
  const root = await distRoot(t, TREE);
  assert.deepEqual(wslFiles(root), ['test/wsl-real/a.test.js', 'test/wsl-real/b.test.js']);
});

test('the lane refuses to start, exit 1 and one line, with HIVE_WSL_DISTRO unset or empty, even with tests to run (#948)', async (t) => {
  const root = await distRoot(t, TREE);
  for (const distro of [undefined, '']) {
    const { code, stderr } = await runLane(root, distro);
    assert.equal(code, 1, `HIVE_WSL_DISTRO=${String(distro)}`);
    assert.equal(stderr.trim(), 'test-wsl: HIVE_WSL_DISTRO is empty: the lane has no distro to test');
  }
});

test('the lane refuses to start, exit 1 and one line, when dist/test/wsl-real/ holds no test file (#948)', async (t) => {
  const root = await distRoot(t, { 'test/wsl-real/real-wsl.js': '', 'test/a.test.js': PASSING });
  const { code, stderr } = await runLane(root, 'Debian-13');
  assert.equal(code, 1);
  assert.equal(stderr.trim(), `test-wsl: no *.test.js under ${join(root, 'test', 'wsl-real')}`);
});

test('with a distro and its tests the lane runs them under node --test and exits with their result (#948)', async (t) => {
  const root = await distRoot(t, TREE);
  const { code, stderr } = await runLane(root, 'Debian-13');
  assert.equal(code, 0, stderr);
});
