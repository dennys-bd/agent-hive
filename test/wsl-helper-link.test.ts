import { after, type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineError } from '../src/machine.js';
import { helperHash } from '../src/wsl/helper-install.js';
import { type LinkDeps, SPAWN_LINE, startLink } from '../src/wsl/helper-link.js';
import { buildHelperBundle, DISTRO, fakeWslDeps, MUTE_HELPER } from './fake-distro.js';
import { tempDir } from './temp-dir.js';

const BUNDLE = await buildHelperBundle({ after });
const ID = `wsl:${DISTRO}`;
const ABORT_AFTER_MS = 200;
const helperFailed = (err: unknown): boolean => err instanceof MachineError && err.code === MachineError.UNAVAILABLE && err.reason === 'helper_failed';
const closeOf = (child: ChildProcess | undefined): Promise<void> =>
  child === undefined || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('close', () => resolve()));

// A distro home with `file` installed as its helper, the link's deps over the fake wsl.exe, and the children and log lines it made
async function installed(t: TestContext, file: string) {
  const home = await tempDir(t, 'wsl-distro-');
  const folder = join(home, '.config', 'agent-hive', 'wsl');
  const hash = helperHash(await readFile(file));
  await mkdir(folder, { recursive: true });
  await copyFile(file, `${folder}/helper-${hash}.mjs`);
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const deps: LinkDeps = {
    ...fakeWslDeps(home), distro: DISTRO, node: process.execPath, log: (line) => logs.push(line),
    spawn: (f, a, o) => { const child = spawn(f, a, o); children.push(child); return child; },
  };
  return { deps, folder, hash, children, logs };
}

test('the spawn line has no backslash, which Git for Windows\' sh.exe would collapse (#945)', () => {
  assert.ok(!SPAWN_LINE.includes('\\'));
});

test('a link to an installed helper gets its hello, logs its stderr line by line under the distro, and stop() ends it (#945)', async (t) => {
  const r = await installed(t, BUNDLE);
  const link = startLink(r.deps, ID, r.folder, r.hash, new AbortController().signal);
  t.after(() => link.stop());
  const hello = await link.hello;
  assert.deepEqual([hello.info.platform, Number.isInteger(hello.relayPort), link.isEnded()], [process.platform, true, false]);
  assert.ok(r.children[0]?.spawnargs.includes(SPAWN_LINE));
  link.stop();
  await closeOf(r.children[0]);
  assert.equal(link.isEnded(), true);
  assert.ok(r.logs.includes(`wsl ${DISTRO}: wsl-helper: folder ${r.folder}`), r.logs.join('\n'));
});

test('a helper that never says hello is stopped when the start\'s signal aborts, and its hello rejects with helper_failed (#945)', async (t) => {
  const mute = join(await tempDir(t, 'wsl-mute-'), 'mute.mjs');
  await writeFile(mute, MUTE_HELPER);
  const r = await installed(t, mute);
  const controller = new AbortController();
  const link = startLink(r.deps, ID, r.folder, r.hash, controller.signal);
  setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  await assert.rejects(link.hello, helperFailed);
  await closeOf(r.children[0]);
  assert.equal(link.isEnded(), true);
});

test('a helper that exits before its hello rejects it with helper_failed, ends the link and leaves node\'s error in the log (#945)', async (t) => {
  const r = await installed(t, BUNDLE);
  const link = startLink(r.deps, ID, r.folder, '0000000000000000', new AbortController().signal);
  await assert.rejects(link.hello, helperFailed);
  await closeOf(r.children[0]);
  assert.equal(link.isEnded(), true);
  assert.ok(r.logs.some((line) => line.startsWith(`wsl ${DISTRO}: `)), 'node\'s own error reached the log');
});
