import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseLock, takeLock } from '../../src/benchmark/run-lock.js';
import { tempDir } from '../temp-dir.js';

test("takeLock writes run.lock with this pid; a live holder refuses, a dead or unreadable one is taken over; releaseLock removes it, twice too (#472)", async (t) => {
  const dir = await tempDir(t, 'lock-');
  const lock = join(dir, 'run.lock');
  const alive = (pid: number): boolean => pid === 111;
  assert.equal(await takeLock(dir, { pid: 111, alive }), true);
  assert.equal(await readFile(lock, 'utf8'), '111\n');
  assert.equal(await takeLock(dir, { pid: 222, alive }), false);
  assert.equal(await readFile(lock, 'utf8'), '111\n');
  await writeFile(lock, '333\n');
  assert.equal(await takeLock(dir, { pid: 222, alive }), true);
  assert.equal(await readFile(lock, 'utf8'), '222\n');
  await writeFile(lock, 'not a pid');
  assert.equal(await takeLock(dir, { pid: 444, alive }), true);
  await releaseLock(dir);
  assert.equal(existsSync(lock), false);
  await releaseLock(dir);
});

test('an empty lock is held, not stale: it may be a pid still being written (#472)', async (t) => {
  const dir = await tempDir(t, 'lock-');
  const lock = join(dir, 'run.lock');
  await writeFile(lock, '');
  assert.equal(await takeLock(dir, { pid: 222, alive: () => false }), false);
  assert.equal(await readFile(lock, 'utf8'), '');
});

test('Hives racing for a free lock or a stale one: exactly one wins, and no temp file is left behind (#472)', async (t) => {
  const dir = await tempDir(t, 'lock-');
  const alive = (pid: number): boolean => pid < 100;
  const racers = [1, 2, 3, 4, 5].map((pid) => takeLock(dir, { pid, alive }));
  assert.equal((await Promise.all(racers)).filter(Boolean).length, 1);
  assert.deepEqual(await readdir(dir), ['run.lock']);
  await writeFile(join(dir, 'run.lock'), '500\n');
  const takeovers = [11, 12, 13, 14, 15].map((pid) => takeLock(dir, { pid, alive: (p) => p < 100 && p > 10 }));
  assert.equal((await Promise.all(takeovers)).filter(Boolean).length, 1);
  assert.deepEqual(await readdir(dir), ['run.lock']);
});

test('an I/O error taking the lock rejects instead of answering another Hive holds it (#472)', async (t) => {
  const dir = await tempDir(t, 'lock-');
  await assert.rejects(takeLock(join(dir, 'missing'), { pid: 1 }));
});
