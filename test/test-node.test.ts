import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TestNode from '../scripts/test-node.mjs';
import { until } from './lsp-helpers.js';
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

test('a list replaces the globs, skips blank and # lines and reads `\\` as `/` (#624)', async (t) => {
  const root = await distRoot(t);
  const list = await listFile(t, '# the lane\n\ntest/fixtures/runner/e.js\r\ntest\\b.test.js\n   \n');
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

// Compiled to dist/test/fixtures/runner/, outside every glob: only a list reaches it.
const PROBE = 'test/fixtures/runner/env-probe.js';

interface Seen { codexHome: string; claudeConfigDir: string }

async function startRunner(t: TestContext, mode: 'pass' | 'fail' | 'wait', extra: readonly string[] = []) {
  const list = await listFile(t, `${PROBE}\n`);
  const out = join(dirname(list), 'probe.json');
  // inherited, NODE_TEST_CONTEXT would make the runner's node --test report to this run instead of running
  const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;
  // ignored: the inner run's report must not mix into this file's own output
  const child = spawn(process.execPath, [fileURLToPath(RUNNER), `--list=${list}`, ...extra], { env: { ...env, PROBE_OUT: out, PROBE_MODE: mode }, stdio: 'ignore' });
  return { child, out, exited: once(child, 'exit') };
}

function assertHomeGone(out: string): void {
  const { codexHome, claudeConfigDir }: Seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(claudeConfigDir, join(codexHome, 'claude'));
  assert.match(basename(codexHome), /^hive-test-/);
  assert.equal(existsSync(codexHome), false, 'the runner removes its throwaway home');
}

test('the runner gives a passing run its throwaway homes, exits 0 and removes them (#624)', async (t) => {
  const { out, exited } = await startRunner(t, 'pass');
  const [code] = await exited;
  assert.equal(code, 0);
  assertHomeGone(out);
});

test('the runner exits with a failing run\'s code and still removes the homes (#624)', async (t) => {
  const { out, exited } = await startRunner(t, 'fail');
  const [code] = await exited;
  assert.equal(code, 1);
  assertHomeGone(out);
});

test('an interrupted runner forwards SIGINT, fails and removes the homes once the run is gone (#624)', { skip: process.platform === 'win32' && 'win32 has no POSIX signal to forward' }, async (t) => {
  const { child, out, exited } = await startRunner(t, 'wait');
  await until(() => existsSync(out));
  child.kill('SIGINT');
  const [code] = await exited;
  assert.notEqual(code, 0);
  assertHomeGone(out);
});

test('--test-timeout reaches node --test, so a hung test fails by its own name instead of holding the run (#654)', async (t) => {
  const started = Date.now();
  const { out, exited } = await startRunner(t, 'wait', ['--test-timeout=500']);
  const [code] = await exited;
  assert.notEqual(code, 0);
  assert.ok(Date.now() - started < 20_000, 'the probe waits 30 s; the timeout must end it first');
  assertHomeGone(out);
});

test('--junit writes a junit report of the run beside the spec output, from the runner\'s own argv only (#654)', async (t) => {
  const junit = join(await tempDir(t, 'runner-junit-'), 'report.xml');
  const { out, exited } = await startRunner(t, 'pass', [`--junit=${junit}`]);
  const [code] = await exited;
  assert.equal(code, 0);
  assert.match(readFileSync(junit, 'utf8'), /<testcase name="env probe"/);
  assertHomeGone(out);
});
