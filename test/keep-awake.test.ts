import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as settle } from 'node:timers/promises';
import { createKeepAwake, type KeepAwake } from '../src/keep-awake.js';
import { keepAwakeCommand } from '../src/platform-commands.js';
import { type FakeKeepAwakeChild, fakeKeepAwakeSpawn } from './fakes.js';

const PID = 4242;

function holder(platform: NodeJS.Platform = 'darwin'): { keepAwake: KeepAwake; children: FakeKeepAwakeChild[]; failures: Error[] } {
  const { spawn, children } = fakeKeepAwakeSpawn();
  const failures: Error[] = [];
  const keepAwake = createKeepAwake({ spawn, pid: PID, platform, onFailure: (err) => failures.push(err) });
  return { keepAwake, children, failures };
}

test('sync(true) twice spawns the platform\'s command once, for the given pid (#226)', () => {
  const { keepAwake, children } = holder();
  keepAwake.sync(true);
  keepAwake.sync(true);
  assert.equal(children.length, 1);
  assert.deepEqual([children[0].file, children[0].args], keepAwakeCommand('darwin', PID));
});

test('sync(false) kills the child and that kill is no failure; a second sync(false) does nothing; stop() kills a held child (#226)', async () => {
  const { keepAwake, children, failures } = holder();
  keepAwake.sync(true);
  keepAwake.sync(false);
  keepAwake.sync(false);
  assert.equal(children[0].kills, 1);
  keepAwake.sync(true);
  assert.equal(children.length, 2, 'on again: a new child');
  keepAwake.stop();
  keepAwake.stop();
  assert.equal(children[1].kills, 1);
  await settle();
  assert.deepEqual(failures, []);
});

test('an error event reports once and forgets the child, so the next sync(true) spawns again (#226)', () => {
  const { keepAwake, children, failures } = holder();
  keepAwake.sync(true);
  children[0].emit('error', new Error('spawn caffeinate ENOENT'));
  children[0].emit('exit', -2, null);
  assert.deepEqual(failures.map((e) => e.message), ['spawn caffeinate ENOENT']);
  keepAwake.sync(true);
  assert.equal(children.length, 2);
});

test('the child exiting while still wanted reports once, naming the command and its code (#226)', () => {
  const { keepAwake, children, failures } = holder();
  keepAwake.sync(true);
  children[0].emit('exit', 1, null);
  children[0].emit('exit', 1, null);
  assert.deepEqual(failures.map((e) => e.message), ['caffeinate exited (1)']);
});

test('an unsupported platform reports its throw once, only after sync has returned: never inside the dispatch that called it (#226)', async () => {
  const { keepAwake, children, failures } = holder('aix');
  keepAwake.sync(true);
  assert.equal(failures.length, 0, 'deferred');
  await settle();
  assert.deepEqual(failures.map((e) => e.message), ['Keep awake is not supported on aix']);
  assert.equal(children.length, 0);
});

// Room for powershell.exe to start and compile its P/Invoke on a cold runner; the watched pid itself lives a second.
const KEEP_AWAKE_EXIT_MS = 30_000;

test('on Windows the keep awake process ends by itself soon after the watched pid ends (#646)', { skip: process.platform !== 'win32' && 'Windows only: runs on the Windows lane', timeout: KEEP_AWAKE_EXIT_MS }, async () => {
  const watched = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' });
  const [file, args] = keepAwakeCommand(process.platform, watched.pid!);
  const holder = spawn(file, [...args], { stdio: 'ignore' });
  const [code] = (await once(holder, 'exit')) as [number | null];
  assert.equal(watched.exitCode, 0, 'the holder outlived nothing: the watched pid ended first');
  assert.equal(code, 0);
});
