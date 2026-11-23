import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import { agentsOnPath } from '../src/agents.js';
import type { MachineInfo } from '../src/machine.js';
import { localFs, localWatch } from '../src/machine-local-fs.js';
import { runDetached } from '../src/machine-run.js';
import { RemoteError } from '../src/remote/protocol.js';
import { helperMachine, isExecutableFile, keepPort, keptPort, RELAY_PORT_FILE, wslVersionOf } from '../src/wsl/helper-main.js';
import { NO_POSIX_FAULTS } from './posix-only.js';
import { tempDir } from './temp-dir.js';

test('wslVersionOf reads osrelease: 2 for WSL2, 1 for WSL1, null for plain Linux and for a read that fails (#941)', () => {
  assert.deepEqual([
    wslVersionOf(() => '5.15.167.4-microsoft-standard-WSL2\n'),
    wslVersionOf(() => '4.4.0-19041-Microsoft\n'),
    wslVersionOf(() => '6.8.0-45-generic\n'),
    wslVersionOf(() => { throw new Error('ENOENT: /proc/sys/kernel/osrelease'); }),
  ], [2, 1, null, null]);
});

test('keptPort answers the port relay-port holds, and undefined for a missing file or anything that is no port (#941)', async (t) => {
  const folder = await tempDir(t, 'wsl-helper-');
  assert.equal(await keptPort(folder), undefined, 'no file');
  for (const text of ['', 'abc', '0', '65536', '12.5', '-1', '80 81']) {
    await writeFile(join(folder, RELAY_PORT_FILE), text);
    assert.equal(await keptPort(folder), undefined, JSON.stringify(text));
  }
  await writeFile(join(folder, RELAY_PORT_FILE), '47999\n');
  assert.equal(await keptPort(folder), 47999);
});

test('keepPort creates the folder, writes the port and a line break, and replaces an older one with no temp file left (#941)', async (t) => {
  const folder = join(await tempDir(t, 'wsl-helper-'), 'hive', 'nested');
  await keepPort(folder, 41000);
  await keepPort(folder, 41001);
  assert.equal(await readFile(join(folder, RELAY_PORT_FILE), 'utf8'), '41001\n');
  assert.deepEqual(await readdir(folder), [RELAY_PORT_FILE]);
});

test('helperMachine is the local disk, runDetached and the local watch under the id local, with the info it was given; process and pty refuse with not_supported (#941)', () => {
  const info: MachineInfo = { platform: 'linux', arch: 'x64', homedir: '/home/u', tmpdir: '/tmp', path: '/usr/bin', shell: '/bin/sh', agents: [] };
  const machine = helperMachine(info);
  assert.deepEqual(
    [machine.id, machine.fs === localFs, machine.run === runDetached, machine.watch === localWatch, machine.paths === path.posix, machine.info()],
    ['local', true, true, true, true, info],
  );
  const refused = (err: unknown): boolean => err instanceof RemoteError && err.code === 'not_supported';
  assert.throws(() => machine.process(process.execPath, [], { cwd: '/', env: {} }), refused);
  assert.throws(() => machine.pty.has('p1'), refused);
});

test('isExecutableFile, as the helper passes it to agentsOnPath: an executable file in ~/.local/bin is an agent, a directory of that name is not (#941)', async (t) => {
  const home = await tempDir(t, 'wsl-home-');
  const bin = join(home, '.local', 'bin');
  await mkdir(join(bin, 'claude'), { recursive: true });
  await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
  await chmod(join(bin, 'codex'), 0o755);
  const found = agentsOnPath({ path: '', home, isExecutable: isExecutableFile });
  assert.deepEqual(found.filter((a) => a.available).map((a) => a.agent), ['codex']);
  // win32's access(X_OK) only checks that the file exists, so a 0644 file passes there
  await t.test('a file without its execute bit is not an agent', { skip: NO_POSIX_FAULTS }, async () => {
    await chmod(join(bin, 'codex'), 0o644);
    assert.equal(isExecutableFile(join(bin, 'codex')), false);
  });
});
