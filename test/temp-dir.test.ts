import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempDir } from './temp-dir.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // this file runs from dist/test/: the sources are two levels up
const FIXTURE = fileURLToPath(new URL('./fixtures/temp-dir-fails.js', import.meta.url)); // compiled next to this file
// The call the guard looks for, spelled so that this file does not match it.
const MAKES_TEMP_DIR = /mk[d]temp/;

test('tempDir makes hive-<prefix>… under os.tmpdir() and removes it after the test, after every hook the test registered later (#428)', async (t) => {
  let dir = '';
  let seenByLaterHook: boolean | undefined;
  await t.test('a test that writes into its dir and closes something there in a later hook', async (inner) => {
    dir = await tempDir(inner, 'probe-');
    await writeFile(join(dir, 'left.txt'), 'x');
    inner.after(async () => { seenByLaterHook = existsSync(dir); }); // what a server's close would write into: still there
    assert.equal(dirname(dir), tmpdir());
    assert.match(basename(dir), /^hive-probe-/);
  });
  assert.equal(seenByLaterHook, true, 'the removal waits for the hooks registered after it');
  assert.equal(existsSync(dir), false, 'gone, with what was written in it, once the test is over');
});

test('tempDir removes its dir after a test that fails, and a module-level dir after the file, in a real node --test run (#428)', async () => {
  const { NODE_TEST_CONTEXT: _runner, ...env } = process.env; // inherited, it would make the child report to this runner instead of running
  const failed = await run(process.execPath, ['--test', '--test-reporter=tap', FIXTURE], { env }).then(
    () => assert.fail('the fixture test fails on purpose'),
    (err: { code?: number; stdout?: string }) => err,
  );
  assert.equal(failed.code, 1);
  const dirs = [...(failed.stdout ?? '').matchAll(/TEMP_DIR=(\S+)/g)].map(([, dir]) => dir);
  assert.equal(dirs.length, 2, failed.stdout);
  for (const dir of dirs) assert.equal(existsSync(dir), false, `${dir} is still there`);
});

test('no file under test/ makes a temp dir of its own but temp-dir.ts: every other one goes through tempDir, which removes it (#428)', async () => {
  const files = (await readdir(join(ROOT, 'test'), { recursive: true })).filter((file) => /\.tsx?$/.test(file));
  const sources = await Promise.all(files.map(async (file) => ({ path: `test/${file}`, text: await readFile(join(ROOT, 'test', file), 'utf8') })));
  const makers = sources.filter(({ text }) => MAKES_TEMP_DIR.test(text)).map(({ path }) => path).sort();
  assert.deepEqual(makers, ['test/temp-dir.ts'], 'make it with tempDir(t, prefix) from test/temp-dir.ts');
});
