import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Machine, MachineError } from '../src/machine.js';
import { serveMachine } from '../src/remote/machine-serve.js';
import { type BigIntStats, direntsOf, encodeDirent, encodeStats, machineErrorOf, remoteErrorOf, splitLines, statsOf } from '../src/remote/machine-wire.js';
import { RemoteError } from '../src/remote/protocol.js';
import { fakeMachine } from './fake-machine.js';
import { pair, remote, settle } from './remote-pair.js';
import { tempDir } from './temp-dir.js';

// what a text frame does to a value on its way across the mux
const cross = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const BIG_INO = 2n ** 53n + 1n; // 9007199254740993: as a number it rounds to ...992, and two files would share an inode (#908)
// a folder's bigint lstat, as a disk whose file ids pass 2^53 answers it (NTFS, ReFS)
const BIG_DIR = {
  dev: 1n, ino: BIG_INO, mode: 0o40755n, nlink: 2n, uid: 0n, gid: 0n, rdev: 0n, size: 64n, blksize: 4096n, blocks: 0n,
  atimeMs: 1n, mtimeMs: 2n, ctimeMs: 3n, birthtimeMs: 4n, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
} as unknown as BigIntStats;

test('splitLines breaks on CR LF, a lone CR and LF, and a final break starts no line (#937)', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('x\n\ny'), ['x', '', 'y']);
  assert.deepEqual(splitLines('last\r\n'), ['last']);
  assert.deepEqual(splitLines(''), []);
});

test('a Stats and a Dirent cross as their numbers and a kind, and come back with their is* (#937)', async (t) => {
  const dir = await tempDir(t, 'wire-');
  await writeFile(join(dir, 'a.txt'), 'abc');
  await mkdir(join(dir, 'sub'));
  const file = await lstat(join(dir, 'a.txt'));
  const back = statsOf(cross(encodeStats(file)), false);
  assert.deepEqual(
    [back.isFile(), back.isDirectory(), back.isSymbolicLink(), back.isFIFO(), back.size, back.ino, back.mtimeMs, back.mtime.getTime()],
    [true, false, false, false, 3, file.ino, file.mtimeMs, new Date(file.mtimeMs).getTime()],
  );
  const entries = direntsOf(cross((await readdir(dir, { withFileTypes: true })).map(encodeDirent)));
  assert.deepEqual(entries.map((e) => [e.name, e.parentPath, e.isFile(), e.isDirectory()]).sort(), [['a.txt', dir, true, false], ['sub', dir, false, true]]);
});

test('a bigint Stats crosses as decimal strings and comes back exact: an ino past 2^53 is the same BigInt (#937)', () => {
  const wire = cross(encodeStats(BIG_DIR));
  assert.equal((wire as { ino: unknown }).ino, '9007199254740993');
  const back = statsOf(wire, true);
  assert.deepEqual([back.ino, back.size, back.isDirectory(), back.mtime.getTime()], [BIG_INO, 64n, true, 2]);
});

test('a MachineError crosses as a RemoteError of its code as a string with its fields as data, and comes back field for field (#937)', () => {
  const sent = remoteErrorOf(new MachineError('git failed', { code: 128, stderr: 'fatal', stdout: 'out', killed: true }));
  assert.deepEqual([sent.code, sent.message], ['128', 'git failed']);
  const back = machineErrorOf(new RemoteError(sent.code, sent.message, cross(sent.data)));
  assert.deepEqual([back instanceof MachineError, back.code, back.stderr, back.stdout, back.killed, back.message], [true, 128, 'fatal', 'out', true, 'git failed']);
  assert.equal(remoteErrorOf(Object.assign(new Error('no such file'), { code: 'ENOENT' })).code, 'ENOENT');
  assert.equal(remoteErrorOf(new Error('plain')).code, 'internal');
  const closed = machineErrorOf(new RemoteError('link_closed', 'the link is closed'));
  assert.deepEqual([closed.code, closed.reason], [MachineError.UNAVAILABLE, 'link_closed']);
  assert.equal(machineErrorOf(new RemoteError('cancelled', 'the request was cancelled')).code, 'ABORT_ERR');
  assert.equal(machineErrorOf(new RemoteError('bad_params', 'not its shape')).code, 'bad_params');
});

test('serveMachine answers unknown_method for a method it does not serve and bad_params for params not of its shape, before the machine sees them (#937)', async () => {
  const calls: string[] = [];
  const { host, machine: far } = pair();
  serveMachine(far, fakeMachine({ fs: { unlink: async (path) => { calls.push(path); } } }));
  const refused = [
    ['fs.readLines', ['/a', { maxBytes: 1 }], 'unknown_method'], ['toString', [], 'unknown_method'], ['process', ['node', []], 'unknown_method'],
    ['fs.unlink', [42], 'bad_params'], ['fs.unlink', ['/a', 'extra'], 'bad_params'], ['fs.unlink', { path: '/a' }, 'bad_params'],
    ['fs.readFile', ['/a', {}], 'bad_params'], ['exec', ['git', 'status'], 'bad_params'], ['run', [{ command: 'x' }], 'bad_params'],
    ['watch', ['/a'], 'bad_params'],
  ] as const;
  await Promise.all(refused.map(([method, params, code]) => assert.rejects(host.request(1, method, params), remote(code), method)));
  assert.deepEqual(calls, []);
  await host.request(1, 'fs.unlink', ['/a']);
  assert.deepEqual(calls, ['/a']);
});

test('serveMachine answers a Stats as its numbers and kind and a file as bytes, and a failure as its code with the MachineError fields as data; exec gets a signal (#937)', async (t) => {
  const dir = await tempDir(t, 'serve-');
  let execSignal: unknown;
  const exec: Machine['exec'] = async (_file, _args, opts) => {
    execSignal = opts?.signal;
    throw new MachineError('git failed', { code: 128, stderr: 'fatal: not a repo', killed: true });
  };
  const { host, machine: far } = pair();
  serveMachine(far, { ...fakeMachine(), exec });
  assert.equal(((await host.request(1, 'fs.stat', [dir])) as { kind: unknown }).kind, 'directory');
  await host.request(1, 'fs.writeFile', [join(dir, 'a.bin'), Uint8Array.of(0, 255)]);
  assert.deepEqual(await host.request(1, 'fs.readFile', [join(dir, 'a.bin'), { maxBytes: 8 }]), Uint8Array.of(0, 255));
  const missing = await host.request(1, 'fs.stat', [join(dir, 'gone')]).catch((err: unknown) => err);
  assert.ok(remote('ENOENT')(missing));
  assert.equal(((missing as RemoteError).data as { code: unknown }).code, 'ENOENT');
  const failed = await host.request(1, 'exec', ['git', ['status']]).catch((err: unknown) => err);
  assert.ok(remote('128')(failed));
  assert.deepEqual((failed as RemoteError).data, { code: 128, stderr: 'fatal: not a repo', stdout: '', killed: true });
  assert.ok(execSignal instanceof AbortSignal);
});

test('serveMachine sends run\'s output and watch\'s filenames as events; a cancel aborts the run and closes the watcher, and a watch cancelled before it started opens none (#937)', async () => {
  const seen = { runSignal: undefined as AbortSignal | undefined, opened: 0, isClosed: false };
  let emit: (filename: string | null) => void = () => undefined;
  const run: Machine['run'] = (p) => new Promise((resolve) => {
    seen.runSignal = p.signal;
    p.onOutput?.('one\n');
    p.onOutput?.('two\n');
    p.signal?.addEventListener('abort', () => resolve({ code: 'stopped', stdout: Buffer.alloc(0), stderr: '', tail: '', failure: 'cancelled' }));
  });
  const watch: Machine['watch'] = (_path, _options, onEvent) => {
    seen.opened += 1;
    emit = onEvent;
    return { close: () => { seen.isClosed = true; } };
  };
  const { host, machine: far } = pair();
  serveMachine(far, { ...fakeMachine({ run }), watch });
  const chunks: unknown[] = [];
  const stopRun = new AbortController();
  const running = host.request(1, 'run', [{ command: 'fmt', args: [], cwd: '/wt', env: {} }], { signal: stopRun.signal, onEvent: (data) => chunks.push(data) });
  await settle();
  stopRun.abort();
  await assert.rejects(running, remote('cancelled'));
  await settle();
  assert.deepEqual([chunks, seen.runSignal?.aborted], [['one\n', 'two\n'], true]);
  const events: unknown[] = [];
  const stopWatch = new AbortController();
  const watching = host.request(1, 'watch', ['/wt', { recursive: true }], { signal: stopWatch.signal, onEvent: (data) => events.push(data) });
  await settle();
  emit('a.txt');
  emit(null);
  await settle();
  stopWatch.abort();
  await assert.rejects(watching, remote('cancelled'));
  await settle();
  assert.deepEqual([events, seen.isClosed], [['a.txt', null], true]);
  const early = new AbortController();
  const crossed = host.request(1, 'watch', ['/wt', { recursive: true }], { signal: early.signal });
  early.abort(); // the cancel follows the request on the wire, so the handler starts with its signal already aborted
  await assert.rejects(crossed, remote('cancelled'));
  await settle();
  assert.equal(seen.opened, 1, 'a watch cancelled before it started opens nothing');
});
