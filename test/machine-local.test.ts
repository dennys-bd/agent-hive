import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import path, { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { MachineError } from '../src/machine.js';
import { createLocalMachine, createLocalMachines, LOCAL_DISK, localDisk } from '../src/machine-local.js';
import { runDetached } from '../src/machine-run.js';
import { posixShell } from '../src/posix-shell.js';
import type { Exec } from '../src/types.js';
import { localDeps as deps, fakeMachine as fakeLocal, machineWith } from './fake-machine.js';
import { fakeMachine } from './fakes.js';
import { assertMode, NO_POSIX_FAULTS } from './posix-only.js';
import { tempDir } from './temp-dir.js';

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
  const machine = createLocalMachine(deps({ env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/claude-config', CODEX_HOME: '/codex-home' } }));
  const first = machine.info();
  assert.deepEqual([first.platform, first.path, first.shell, first.claudeConfigDir, first.codexHome, first.agents], [process.platform, '/usr/bin', posixShell().shell, '/claude-config', '/codex-home', []]);
  assert.equal(machine.info(), first);
});

test('until node 8 every activity is on the local machine, one with an unknown machine id included; its run is runDetached (#158)', () => {
  const machines = createLocalMachines(deps());
  assert.equal(machines.for({}), machines.local);
  assert.equal(machines.for({ machine: 'AB:CD' }), machines.local);
  assert.deepEqual([machines.local.id, machines.local.run === runDetached, machines.local.pty.has('nope')], ['local', true, false]);
});

test('localDisk is the local fs and the exec turned into MachineError: what createLocalMachine is built on (#159)', async () => {
  const failing: Exec = async () => { throw Object.assign(new Error('Command failed: git status'), { code: 128, stderr: 'fatal: not a git repository' }); };
  const disk = localDisk(failing);
  await assert.rejects(disk.exec('git', ['status']), (err: unknown) => err instanceof MachineError && err.code === 128 && err.stderr === 'fatal: not a git repository');
  assert.equal(disk.fs, createLocalMachine(deps()).fs, 'one fs table');
  assert.equal(LOCAL_DISK.fs, disk.fs);
});

const linesOf = async (lines: AsyncIterable<string>): Promise<string[]> => {
  const read: string[] = [];
  for await (const line of lines) read.push(line);
  return read;
};
const isCode = (code: string) => (err: unknown): boolean => err instanceof MachineError && err.code === code;

test('fs.readLines yields every line of a file, CR LF as one break (#161)', async (t) => {
  const file = join(await tempDir(t, 'machine-'), 'a.jsonl');
  await writeFile(file, 'one\r\ntwo\nthree');
  assert.deepEqual(await linesOf(createLocalMachine(deps()).fs.readLines(file, { maxBytes: 1024 })), ['one', 'two', 'three']);
});

test('fs.readLines refuses a file over maxBytes with too_large on the first next(), before any line (#161)', async (t) => {
  const file = join(await tempDir(t, 'machine-'), 'a.jsonl');
  await writeFile(file, 'one\ntwo\n');
  const seen: string[] = [];
  const read = async (): Promise<void> => { for await (const line of createLocalMachine(deps()).fs.readLines(file, { maxBytes: 4 })) seen.push(line); };
  await assert.rejects(read(), isCode(MachineError.TOO_LARGE));
  assert.deepEqual(seen, []);
});

// mkfifo is POSIX: the FIFO is this test's only case, so the whole test is skipped on win32
test('fs.readLines refuses a FIFO with not_file instead of waiting on it forever (#161)', { skip: NO_POSIX_FAULTS }, async (t) => {
  const fifo = join(await tempDir(t, 'machine-'), 'pipe.jsonl');
  await promisify(execFile)('mkfifo', [fifo]);
  await assert.rejects(linesOf(createLocalMachine(deps()).fs.readLines(fifo, { maxBytes: 1024 })), isCode(MachineError.NOT_FILE));
});

// return() is what a loop's break calls: it runs readLines' finally, which destroys the stream
test('breaking out of the loop after one line ends the read: the iterator is done after it (#161)', async (t) => {
  const file = join(await tempDir(t, 'machine-'), 'a.jsonl');
  await writeFile(file, 'one\ntwo\n');
  const lines = createLocalMachine(deps()).fs.readLines(file, { maxBytes: 1024 })[Symbol.asyncIterator]();
  assert.deepEqual(await lines.next(), { done: false, value: 'one' });
  assert.deepEqual(await lines.return?.(), { done: true, value: undefined });
  assert.deepEqual(await lines.next(), { done: true, value: undefined });
});

test('process starts the command in the given cwd with the given env, and its stdout reaches the caller (#161)', async (t) => {
  const dir = await tempDir(t, 'machine-');
  const script = "process.stdout.write(require('node:path').basename(process.cwd()) + '|' + process.env.HIVE_PROBE_161)";
  const child = createLocalMachine(deps()).process(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, HIVE_PROBE_161: 'probe' } });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  await new Promise((resolve) => child.once('close', resolve));
  assert.equal(out, `${basename(dir)}|probe`);
});

test('paths is the platform\'s flavour, whatever the host: win32 joins with \\, linux with / (#927)', () => {
  assert.equal(createLocalMachine(deps({ platform: 'win32' })).paths, path.win32);
  assert.equal(createLocalMachine(deps({ platform: 'linux' })).paths, path.posix);
  assert.equal(createLocalMachine(deps({ platform: 'darwin' })).paths, path.posix);
});

test('the fake machines answer paths for the platform they were given (#927)', () => {
  assert.equal(fakeLocal({ platform: 'win32' }).paths, path.win32);
  assert.equal(fakeLocal({ platform: 'win32', info: { platform: 'linux' } }).paths, path.posix);
  assert.equal(machineWith({ platform: 'win32' }, fakeLocal({ platform: 'linux' })).paths, path.win32);
  assert.equal(fakeMachine({ info: { platform: 'win32' } }).paths, path.win32);
  assert.equal(fakeMachine({ info: { platform: 'linux' } }).paths, path.posix);
});
