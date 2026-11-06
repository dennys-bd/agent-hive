import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killTree, treeSpawnOptions } from '../src/kill-tree.js';
import type { Exec } from '../src/types.js';
import { childWithGrandchild, gone } from './process-probe.js';

test('on win32 killTree runs taskkill /T /F /PID through the exec, and a failing taskkill never rejects (#637)', async () => {
  const calls: [string, string[]][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    return { stdout: '' };
  };
  await killTree(4242, 'win32', exec);
  assert.deepEqual(calls, [['taskkill', ['/T', '/F', '/PID', '4242']]]);
  // exit 128: the pid is already gone; any other failure is swallowed too
  const failing: Exec = async () => { throw Object.assign(new Error('Command failed: taskkill'), { code: 128 }); };
  await killTree(4242, 'win32', failing);
});

test('an undefined pid (a spawn that never started) does nothing on any platform (#637)', async () => {
  const exec: Exec = async () => assert.fail('no taskkill for a process that never started');
  await killTree(undefined, 'win32', exec);
  await killTree(undefined, 'darwin', exec);
  await killTree(undefined, 'linux', exec);
  // win32 only: were the guard gone, darwin's -0 would SIGKILL this test's own process group
  for (const pid of [0, -1, 1.5]) await killTree(pid, 'win32', exec);
});

test('treeSpawnOptions: not detached on win32, detached on darwin and linux, a hidden window on all three (#637)', () => {
  assert.deepEqual(treeSpawnOptions('win32'), { detached: false, windowsHide: true });
  assert.deepEqual(treeSpawnOptions('darwin'), { detached: true, windowsHide: true });
  assert.deepEqual(treeSpawnOptions('linux'), { detached: true, windowsHide: true });
});

test('off win32: killTree kills a detached child and the grandchild it started, and a pid already gone does not throw (#637)', { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
  const { pid, grandchild } = await childWithGrandchild(t);
  await killTree(pid, process.platform);
  assert.equal(await gone(pid), true, 'the child');
  assert.equal(await gone(grandchild), true, 'the grandchild, through the process group');
  await killTree(pid, process.platform); // ESRCH, swallowed
});

test('on the Windows lane: killTree kills a child and the grandchild it started through taskkill /T, and a pid already gone does not throw (#637)', { skip: process.platform !== 'win32', timeout: 30_000 }, async (t) => {
  const { pid, grandchild } = await childWithGrandchild(t);
  await killTree(pid, process.platform);
  assert.equal(await gone(pid), true, 'the child');
  assert.equal(await gone(grandchild), true, 'the grandchild, through the parent tree');
  await killTree(pid, process.platform); // taskkill exits 128, swallowed
});
