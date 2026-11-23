import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineError } from '../src/machine.js';
import { type BigIntStats, direntsOf, encodeDirent, encodeStats, machineErrorOf, remoteErrorOf, splitLines, statsOf } from '../src/remote/machine-wire.js';
import { RemoteError } from '../src/remote/protocol.js';
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
