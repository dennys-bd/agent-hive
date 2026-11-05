import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as Postinstall from '../scripts/postinstall.mjs';
import { tempDir } from './temp-dir.js';

// .mjs files are not copied to dist/: this file, run from dist/test/, climbs back to the repo's scripts/ (#624).
const { makeSpawnHelperExecutable }: typeof Postinstall = await import(new URL('../../scripts/postinstall.mjs', import.meta.url).href);
const HAS_MODES = process.platform !== 'win32'; // POSIX modes do not apply on win32
const modeOf = (file: string): number => statSync(file).mode & 0o777;

async function withHelpers(t: TestContext): Promise<{ root: string; helpers: string[] }> {
  const root = await tempDir(t, 'postinstall-');
  const helpers = ['darwin-arm64', 'darwin-x64'].map((arch) => join(root, 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper'));
  for (const helper of helpers) {
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
  }
  return { root, helpers };
}

test('on darwin the postinstall makes every node-pty spawn-helper executable (#624)', async (t) => {
  const { root, helpers } = await withHelpers(t);
  makeSpawnHelperExecutable('darwin', root);
  if (HAS_MODES) assert.deepEqual(helpers.map(modeOf), [0o755, 0o755]);
});

test('on linux and win32 the postinstall leaves the helpers alone (#624)', async (t) => {
  const { root, helpers } = await withHelpers(t);
  makeSpawnHelperExecutable('linux', root);
  makeSpawnHelperExecutable('win32', root);
  if (HAS_MODES) assert.deepEqual(helpers.map(modeOf), [0o644, 0o644]);
});

test('on darwin the postinstall fails when node-pty has no spawn-helper where it looks (#624)', async (t) => {
  const root = await tempDir(t, 'postinstall-');
  assert.throws(() => makeSpawnHelperExecutable('darwin', root), /spawn-helper/);
});
