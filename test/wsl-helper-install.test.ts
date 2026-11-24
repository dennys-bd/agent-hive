import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import { MachineError } from '../src/machine.js';
import {
  DISTRO_MISSING, HELPER_FAILED, helperHash, INSTALL_LINE, installHelper, LOGIN_SHELL, NODE_MISSING, NODE_OLD, parseProbe, PROBE_JS, PROBE_LINE,
  probeHelper, startReason,
} from '../src/wsl/helper-install.js';
import { wslArgv, wslEnv, wslExec } from '../src/wsl/wsl-exe.js';
import { DISTRO, fakeWslDeps, spawnChild } from './fake-distro.js';
import { assertMode, NO_FAKE_GETENT } from './posix-only.js';
import { tempDir } from './temp-dir.js';

const FOLDER = '/home/u/.config/agent-hive/wsl';
const BYTES = Buffer.from('the bundle\'s bytes');
const HASH = helperHash(BYTES);
const open = (): AbortSignal => new AbortController().signal;

test('parseProbe: no output is node_missing, a major under 24 node_old, three lines the folder and whether the hash is there; anything else helper_failed (#945)', () => {
  assert.deepEqual(parseProbe(''), { reason: NODE_MISSING });
  assert.deepEqual(parseProbe('20.11.0\n'), { reason: NODE_OLD });
  assert.deepEqual(parseProbe(`20.11.0\n${FOLDER}\nno\n`), { reason: NODE_OLD });
  assert.deepEqual(parseProbe(`24.1.0\n${FOLDER}\nyes\n`), { folder: FOLDER, nodeVersion: '24.1.0', isInstalled: true });
  assert.deepEqual(parseProbe(`24.1.0\r\n${FOLDER}\r\nno\r\n`), { folder: FOLDER, nodeVersion: '24.1.0', isInstalled: false });
  assert.deepEqual(parseProbe('not a version\n'), { reason: HELPER_FAILED });
  assert.deepEqual(parseProbe(`24.1.0\n${FOLDER}\n`), { reason: HELPER_FAILED });
  assert.deepEqual(parseProbe('24.1.0\n/elsewhere\nyes\n'), { reason: HELPER_FAILED });
});

test('helperHash is the first 16 hex characters of the SHA-256, the same for the same bytes (#945)', () => {
  assert.match(HASH, /^[0-9a-f]{16}$/);
  assert.equal(helperHash(Buffer.from('the bundle\'s bytes')), HASH);
  assert.notEqual(helperHash(Buffer.from('another bundle')), HASH);
});

test('startReason: wsl.exe saying the distro does not exist is distro_missing, in its own UTF-16 or read as UTF-8; anything else helper_failed (#945)', () => {
  const asUtf8 = (text: string): string => Buffer.from(text, 'utf16le').toString('utf8');
  assert.equal(startReason(new MachineError('x', { code: 4294967295, stdout: 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n' })), DISTRO_MISSING);
  assert.equal(startReason(new MachineError('x', { code: 1, stdout: asUtf8('There is no distribution with the supplied name.\r\n') })), DISTRO_MISSING);
  assert.equal(startReason(new MachineError('x', { code: 1, stderr: 'mkdir: cannot create directory' })), HELPER_FAILED);
  assert.equal(startReason(new Error('ENOENT')), HELPER_FAILED);
});

test('the shell lines and the probe\'s script have no backslash, which Git for Windows\' sh.exe would collapse (#945)', () => {
  for (const line of [LOGIN_SHELL, PROBE_LINE, PROBE_JS, INSTALL_LINE]) assert.ok(!line.includes('\\'), line);
});

test('probeHelper finds the distro\'s node through its login shell and answers the Hive folder; installHelper writes the hash there and removes any other helper (#945)', async (t) => {
  const home = await tempDir(t, 'wsl-distro-');
  const exec = wslExec(fakeWslDeps(home), DISTRO);
  const fresh = await probeHelper(exec, process.execPath, HASH, open());
  if ('reason' in fresh) assert.fail(fresh.reason);
  const folder = join(home, '.config', 'agent-hive', 'wsl');
  assert.deepEqual([path.resolve(fresh.folder), fresh.nodeVersion, fresh.isInstalled], [folder, process.versions.node, false]);
  const deps = { ...fakeWslDeps(home), distro: DISTRO, spawn: spawnChild };
  await installHelper(deps, fresh.folder, HASH, BYTES, open());
  await assertMode(t, folder, 0o700, 'the folder the install made');
  assert.equal(await readFile(join(folder, `helper-${HASH}.mjs`), 'utf8'), 'the bundle\'s bytes');
  const next = Buffer.from('the next bundle');
  await writeFile(join(folder, 'relay-port'), '41000\n'); // the helper's own file: not a helper, so it stays
  await installHelper(deps, fresh.folder, helperHash(next), next, open());
  assert.deepEqual((await readdir(folder)).sort(), [`helper-${helperHash(next)}.mjs`, 'relay-port'].sort(), 'the old helper removed, no .tmp left');
  const installed = await probeHelper(exec, process.execPath, helperHash(next), open());
  assert.equal('isInstalled' in installed && installed.isInstalled, true);
  const old = await probeHelper(exec, process.execPath, HASH, open());
  assert.equal('isInstalled' in old && old.isInstalled, false);
});

test('probeHelper answers node_missing for a node not found and distro_missing for a distro wsl.exe does not have (#945)', async (t) => {
  const home = await tempDir(t, 'wsl-distro-');
  assert.deepEqual(await probeHelper(wslExec(fakeWslDeps(home), DISTRO), 'no-such-node-945', HASH, open()), { reason: NODE_MISSING });
  const other = wslExec(fakeWslDeps(home, { FAKE_WSL_DISTROS: 'Other' }), DISTRO);
  assert.deepEqual(await probeHelper(other, process.execPath, HASH, open()), { reason: DISTRO_MISSING });
});

test('an install whose stdin ends before the bundle\'s byte count leaves no helper and no .tmp, and exits non-zero (#945)', async (t) => {
  const home = await tempDir(t, 'wsl-distro-');
  const folder = join(home, '.config', 'agent-hive', 'wsl');
  const deps = fakeWslDeps(home);
  const helper = join(folder, `helper-${HASH}.mjs`);
  const { file, args } = wslArgv(deps.command, DISTRO, ['sh', '-c', INSTALL_LINE, 'sh', folder, helper, String(BYTES.length + 1)]);
  const child = spawnChild(file, args, { env: wslEnv({}, deps.env), windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
    child.stdin.end(BYTES); // one byte short of what the line was told: wsl.exe killed mid-pipe
  });
  assert.notEqual(code, 0);
  assert.deepEqual(await readdir(folder), [], 'neither the helper nor its .tmp');
});

test('installHelper tightens a folder that was already there to 0700 (#945)', async (t) => {
  const home = await tempDir(t, 'wsl-distro-');
  const folder = join(home, '.config', 'agent-hive', 'wsl');
  await mkdir(folder, { recursive: true });
  await chmod(folder, 0o755);
  await installHelper({ ...fakeWslDeps(home), distro: DISTRO, spawn: spawnChild }, folder, HASH, BYTES, open());
  await assertMode(t, folder, 0o700, 'the folder that was 0755');
});

test('LOGIN_SHELL runs the line through a POSIX login shell, and through /bin/sh when the passwd entry names fish (#945)', { skip: NO_FAKE_GETENT }, async (t) => {
  const home = await tempDir(t, 'wsl-distro-');
  const bin = join(home, 'bin');
  await mkdir(bin);
  const shellOf = async (entry: string): Promise<string> => {
    await writeFile(join(bin, 'getent'), `#!/bin/sh\necho 'u:x:1000:1000::/home/u:${entry}'\n`);
    await chmod(join(bin, 'getent'), 0o755);
    const exec = wslExec(fakeWslDeps(home, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }), DISTRO);
    return (await exec('sh', ['-c', LOGIN_SHELL, 'sh', 'printf %s "$0" >&3'], { signal: open() })).stdout;
  };
  assert.equal(await shellOf('/bin/bash'), '/bin/bash');
  assert.equal(await shellOf('/usr/bin/fish'), '/bin/sh');
  assert.equal(await shellOf('/bin/tcsh'), '/bin/sh');
});
