import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
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
