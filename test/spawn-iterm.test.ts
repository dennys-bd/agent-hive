import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnItermWorker, workerCommand } from '../src/spawn-iterm.js';
import type { Exec } from '../src/types.js';
import { LAUNCH } from './fakes.js';

interface Call { file: string; args: string[] }

// Records every command. osascript answers a tab id (or fails); pkill always matches; pgrep matches `alive` times, then exit 1 (no match).
function fakeExec(options: { alive?: number; openFails?: boolean } = {}): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  let alive = options.alive ?? 0;
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'osascript') {
      if (options.openFails) throw new Error('osascript boom');
      return { stdout: 'w0t1p0:ABCD\n' };
    }
    if (file === 'pgrep' && alive-- <= 0) throw Object.assign(new Error('no match'), { code: 1 });
    return { stdout: '' };
  };
  return { exec, calls };
}

function handlers() {
  const errors: string[] = [];
  let exits = 0;
  return { errors, exits: () => exits, handlers: { onError: (m: string) => errors.push(m), onExit: () => { exits += 1; } } };
}
const noSleep = async (): Promise<void> => {};
const PGREP = ['pgrep', '-f', '--', '--worktree=hive-1-task'];

test('spawnItermWorker opens a tab typing workerCommand and started resolves once it exists; a failed osascript rejects started with the iTerm message and calls neither onError nor onExit', async () => {
  const ok = fakeExec();
  const h = handlers();
  const handle = spawnItermWorker(LAUNCH, h.handlers, { exec: ok.exec, sleep: noSleep });
  await handle.started;
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].file, 'osascript');
  assert.equal(ok.calls[0].args[2], workerCommand(LAUNCH));
  const failing = fakeExec({ openFails: true });
  const h2 = handlers();
  await assert.rejects(spawnItermWorker(LAUNCH, h2.handlers, { exec: failing.exec, sleep: noSleep }).started, { message: 'iTerm: osascript boom' });
  assert.deepEqual(h2.errors, []);
  assert.equal(h2.exits(), 0, 'the pool reports it as spawnFailed; the exit only ever comes from the curl trailer');
});

test('kill runs pkill by slug and resolves only once pgrep finds nothing, sleeping 200 ms between polls; a second kill is the same kill', async () => {
  const { exec, calls } = fakeExec({ alive: 2 });
  const h = handlers();
  const slept: number[] = [];
  const handle = spawnItermWorker(LAUNCH, h.handlers, { exec, sleep: async (ms) => { slept.push(ms); } });
  await handle.started;
  await handle.kill();
  assert.deepEqual(calls.slice(1).map((c) => [c.file, ...c.args]), [['pkill', '-f', '--', '--worktree=hive-1-task'], PGREP, PGREP, PGREP]);
  assert.deepEqual(slept, [200, 200], 'one wait per match');
  assert.deepEqual(h.errors, []);
  assert.equal(h.exits(), 0, 'the tab reports its own exit through the trailer');
  await handle.kill();
  assert.equal(calls.length, 5, 'the first kill is the kill');
});

test('kill gives up after 10 s of matches (50 polls of 200 ms), resolves and reports it through onError', async () => {
  const { exec, calls } = fakeExec({ alive: 1000 });
  const h = handlers();
  await spawnItermWorker(LAUNCH, h.handlers, { exec, sleep: noSleep }).kill();
  assert.equal(calls.filter((c) => c.file === 'pgrep').length, 50);
  assert.deepEqual(h.errors, ['kill: worker still alive after 10s']);
});
