import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path, { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { MachineError } from '../src/machine.js';
import { createLocalMachine, LOCAL_DISK, localDisk } from '../src/machine-local.js';
import { infoOf, LOCAL_DISK as DISK_OF_MODULE, localDisk as diskOfModule } from '../src/machine-local-disk.js';
import { runDetached } from '../src/machine-run.js';
import { posixShell } from '../src/posix-shell.js';
import type { AgentAvailability, Exec } from '../src/types.js';
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
  const machine = createLocalMachine(deps({ agents: [], env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/claude-config', CODEX_HOME: '/codex-home' } }));
  const first = machine.info();
  assert.deepEqual([first.platform, first.path, first.shell, first.claudeConfigDir, first.codexHome, first.agents], [process.platform, '/usr/bin', posixShell().shell, '/claude-config', '/codex-home', []]);
  assert.equal(machine.info(), first);
});

test('the local machine\'s id is local, its run is runDetached and its pty host knows no pty yet (#158)', () => {
  const machine = createLocalMachine(deps());
  assert.deepEqual([machine.id, machine.run === runDetached, machine.pty.has('nope')], ['local', true, false]);
});

test('localDisk is the local fs and the exec turned into MachineError: what createLocalMachine is built on (#159)', async () => {
  const failing: Exec = async () => { throw Object.assign(new Error('Command failed: git status'), { code: 128, stderr: 'fatal: not a git repository' }); };
  const disk = localDisk(failing);
  await assert.rejects(disk.exec('git', ['status']), (err: unknown) => err instanceof MachineError && err.code === 128 && err.stderr === 'fatal: not a git repository');
  assert.equal(disk.fs, createLocalMachine(deps()).fs, 'one fs table');
  assert.equal(LOCAL_DISK.fs, disk.fs);
});

test('machine-local-disk.ts holds the disk, which machine-local.ts re-exports as the same values, and infoOf, which reads PATH case-blind on win32 only (#941)', () => {
  assert.deepEqual([LOCAL_DISK === DISK_OF_MODULE, localDisk === diskOfModule], [true, true]);
  const agents: AgentAvailability[] = [{ agent: 'claude', available: true }];
  const linux = infoOf({ Path: 'C:\\bin', PATH: '/usr/bin', CODEX_HOME: '/codex-home' }, 'linux', agents);
  const windows = infoOf({ Path: 'C:\\bin' }, 'win32', agents);
  assert.deepEqual([linux.platform, linux.path, linux.codexHome, linux.agents, windows.path], ['linux', '/usr/bin', '/codex-home', agents, 'C:\\bin']);
  assert.notEqual(linux.agents, agents, 'a copy: the caller\'s list is never the machine\'s');
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

const WATCH_WAIT_MS = 5_000; // FSEvents, inotify and ReadDirectoryChangesW all answer well inside it; CI runners are slow
const WRITE_EVERY_MS = 50;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve)); // past the microtask a start-up failure is queued on

// One watch's events and errors, and a promise kept on the first event that names `name`
function hearing(name: string): { heard: Promise<void>; names: (string | null)[]; errors: MachineError[]; onEvent(filename: string | null): void; onError(err: MachineError): void } {
  const names: (string | null)[] = [];
  const errors: MachineError[] = [];
  let hear = (): void => undefined;
  const heard = new Promise<void>((resolve) => { hear = resolve; });
  return {
    heard, names, errors,
    onEvent: (filename) => { names.push(filename); if (filename === name) hear(); },
    onError: (err) => { errors.push(err); },
  };
}

// Writes `file` every WRITE_EVERY_MS until `heard` is kept, false after WATCH_WAIT_MS. Linux arms a recursive watch some time after watch()
// returns, so a single write could land before it. A failed write is retried on the next tick (Windows may hold the file a moment)
function writeUntil(file: string, heard: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    let count = 0;
    const writer = setInterval(() => { writeFile(file, String(count++)).catch(() => undefined); }, WRITE_EVERY_MS);
    const timer = setTimeout(() => finish(false), WATCH_WAIT_MS);
    function finish(isHeard: boolean): void {
      clearInterval(writer);
      clearTimeout(timer);
      resolve(isHeard);
    }
    void heard.then(() => finish(true));
  });
}

test('the local machine\'s watch reports a file written under the watched folder, and nothing after close() (#935)', async (t) => {
  const dir = await tempDir(t, 'watch-');
  const machine = createLocalMachine(deps());
  const first = hearing('a.txt');
  const watcher = machine.watch(dir, { recursive: true }, first.onEvent, first.onError);
  t.after(() => watcher.close());
  assert.ok(await writeUntil(join(dir, 'a.txt'), first.heard), `no event for a.txt within ${WATCH_WAIT_MS} ms`);
  watcher.close();
  const heardBefore = first.names.length;
  // A second watch hearing the next write says the OS delivered it: the closed one must hear nothing of it
  const second = hearing('b.txt');
  const next = machine.watch(dir, { recursive: true }, second.onEvent, second.onError);
  t.after(() => next.close());
  assert.ok(await writeUntil(join(dir, 'b.txt'), second.heard), `no event for b.txt within ${WATCH_WAIT_MS} ms`);
  assert.deepEqual([first.names.length, first.errors, second.errors], [heardBefore, [], []]);
});

test('a watch of a missing path reports ENOENT through onError once, after watch returned, and no event; close() before then suppresses it (#935)', async (t) => {
  const missing = join(await tempDir(t, 'watch-'), 'gone');
  const { watch } = createLocalMachine(deps());
  const errors: MachineError[] = [];
  const events: (string | null)[] = [];
  watch(missing, { recursive: false }, (name) => events.push(name), (err) => errors.push(err));
  assert.equal(errors.length, 0, 'watch never throws, and reports nothing before it returns');
  await settle();
  assert.deepEqual([errors.length, errors[0] instanceof MachineError, errors[0]?.code, events], [1, true, 'ENOENT', []]);
  const suppressed: MachineError[] = [];
  watch(missing, { recursive: false }, () => undefined, (err) => suppressed.push(err)).close();
  await settle();
  assert.deepEqual(suppressed, []);
});

test('fs.readFile with noFollow reads a regular file, and refuses a link as the last component with ELOOP and a file over maxBytes with too_large; without it a link is read as before (#882)', async (t) => {
  const dir = await tempDir(t, 'machine-');
  const file = join(dir, 'a.html');
  const link = join(dir, 'link.html');
  await writeFile(file, '<p>a</p>'); // 8 bytes
  await symlink(file, link);
  const { fs } = createLocalMachine(deps());
  assert.equal(await fs.readFile(file, { maxBytes: 8, noFollow: true, encoding: 'utf8' }), '<p>a</p>');
  assert.deepEqual(await fs.readFile(file, { maxBytes: 8, noFollow: true }), Buffer.from('<p>a</p>'));
  await assert.rejects(fs.readFile(link, { maxBytes: 64, noFollow: true }), (err: unknown) => err instanceof MachineError && err.code === 'ELOOP');
  await assert.rejects(fs.readFile(file, { maxBytes: 7, noFollow: true }), (err: unknown) => err instanceof MachineError && err.code === MachineError.TOO_LARGE);
  assert.equal(await fs.readFile(link, { maxBytes: 64, encoding: 'utf8' }), '<p>a</p>');
});

// mkfifo is POSIX: the FIFO is this test's only case, so the whole test is skipped on win32
test('fs.readFile with noFollow refuses a FIFO with not_file instead of waiting on it for a writer (#882)', { skip: NO_POSIX_FAULTS }, async (t) => {
  const fifo = join(await tempDir(t, 'machine-'), 'pipe.html');
  await promisify(execFile)('mkfifo', [fifo]);
  const { fs } = createLocalMachine(deps());
  await assert.rejects(fs.readFile(fifo, { maxBytes: 64, noFollow: true }), (err: unknown) => err instanceof MachineError && err.code === MachineError.NOT_FILE);
});
