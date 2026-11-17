import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineError } from '../src/machine.js';
import { createLocalMachine, createLocalMachines, type LocalMachineDeps } from '../src/machine-local.js';
import { runDetached } from '../src/machine-run.js';
import { posixShell } from '../src/posix-shell.js';
import { createPtyHost } from '../src/pty-host.js';
import type { Exec, LaunchPty } from '../src/types.js';
import { fakePtys } from './fakes.js';
import { assertMode } from './posix-only.js';
import { tempDir } from './temp-dir.js';

const NO_LAUNCH: LaunchPty = () => ({ started: Promise.resolve(), kill: () => Promise.resolve() });
const deps = (over: Partial<LocalMachineDeps> = {}): LocalMachineDeps => ({
  exec: async () => ({ stdout: '' }), launch: NO_LAUNCH, ptys: createPtyHost(fakePtys().spawnPty), home: '/hive-home', secret: 'fake-secret-158',
  secretFile: '/hive-home/hive.secret', commandShims: '/hive-home/command-shims', port: () => 4242, agents: [], ...over,
});

test('fs.readFile refuses a file over maxBytes with too_large, and answers one at the cap whole, as bytes or as text (#158)', async (t) => {
  const dir = await tempDir(t, 'machine-');
  const file = join(dir, 'a.txt');
  await writeFile(file, '0123456789');
  const { fs } = createLocalMachine(deps());
  await assert.rejects(fs.readFile(file, { maxBytes: 9 }), (err: unknown) => err instanceof MachineError && err.code === MachineError.TOO_LARGE);
  assert.deepEqual(await fs.readFile(file, { maxBytes: 10 }), Buffer.from('0123456789'));
  assert.equal(await fs.readFile(file, { maxBytes: 10, encoding: 'utf8' }), '0123456789');
});

test('fs.readFile refuses a folder with not_file: only a regular file\'s size bounds the read (#158)', async (t) => {
  const dir = await tempDir(t, 'machine-');
  const { fs } = createLocalMachine(deps());
  await assert.rejects(fs.readFile(dir, { maxBytes: 1024 }), (err: unknown) => err instanceof MachineError && err.code === MachineError.NOT_FILE);
});

test('fs.writeAtomic writes the text with the original\'s mode, and a rename that fails leaves no temp file beside it (#158)', async (t) => {
  const dir = await tempDir(t, 'machine-');
  const file = join(dir, 'a.sh');
  await writeFile(file, 'old');
  await chmod(file, 0o750);
  const { fs } = createLocalMachine(deps());
  assert.deepEqual(await fs.writeAtomic(file, 'new'), Buffer.from('new'));
  assert.equal(await fs.readFile(file, { maxBytes: 10, encoding: 'utf8' }), 'new');
  await assertMode(t, file, 0o750);
  const folder = join(dir, 'folder'); // a file renamed over a folder that holds a file fails on every OS
  await mkdir(folder);
  await writeFile(join(folder, 'inside'), '');
  await assert.rejects(fs.writeAtomic(folder, 'text'));
  assert.deepEqual((await readdir(dir)).sort(), ['a.sh', 'folder']);
});

test('exec hands cwd and signal to the exec under it, and its failure rejects as a MachineError with code, stderr, stdout and killed (#158)', async () => {
  const seen: unknown[] = [];
  const failing: Exec = async (_file, _args, opts) => {
    seen.push(opts);
    throw Object.assign(new Error('Command failed: git status'), { code: 128, stderr: 'fatal: not a git repository', stdout: '', killed: false });
  };
  const { exec } = createLocalMachine(deps({ exec: failing }));
  const asExec: Exec = exec; // what lets a sibling pass machine.exec where an Exec is taken
  const signal = new AbortController().signal;
  await assert.rejects(exec('git', ['status'], { cwd: '/repo', signal }), (err: unknown) => {
    assert.ok(err instanceof MachineError);
    assert.deepEqual([err.message, err.code, err.stderr, err.stdout, err.killed], ['Command failed: git status', 128, 'fatal: not a git repository', '', false]);
    return true;
  });
  await assert.rejects(asExec('git', ['status']), MachineError);
  assert.deepEqual(seen, [{ cwd: '/repo', signal }, undefined]);
});

test('info() reads the machine once: platform, PATH, the POSIX shell, CLAUDE_CONFIG_DIR and the agents boot found (#158)', () => {
  const machine = createLocalMachine(deps({ env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/claude-config' } }));
  const first = machine.info();
  assert.deepEqual([first.platform, first.path, first.shell, first.claudeConfigDir, first.agents], [process.platform, '/usr/bin', posixShell().shell, '/claude-config', []]);
  assert.equal(machine.info(), first);
});

test('until node 8 every activity is on the local machine, one with an unknown machine id included; its run is runDetached (#158)', () => {
  const machines = createLocalMachines(deps());
  assert.equal(machines.for({}), machines.local);
  assert.equal(machines.for({ machine: 'AB:CD' }), machines.local);
  assert.deepEqual([machines.local.id, machines.local.run === runDetached, machines.local.pty.has('nope')], ['local', true, false]);
});
