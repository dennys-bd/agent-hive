import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPtyPool } from '../src/ptys.js';
import { fakeSpawn, type FakeSpawnOptions, LAUNCH } from './fakes.js';

const noop = (): void => {};
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function started(ptyId = 'W1', options: FakeSpawnOptions = {}) {
  const { spawn, workers } = fakeSpawn(options);
  const pool = createPtyPool(spawn);
  const exits: string[] = [];
  const errors: string[] = [];
  const failures: string[] = [];
  pool.start({
    ptyId, launch: { ...LAUNCH, ptyId },
    onExit: () => exits.push(ptyId), onError: (message) => errors.push(message), onSpawnFailed: (message) => failures.push(message),
  });
  return { pool, worker: workers[0], workers, exits, errors, failures };
}

test('start hands the launch to the spawner and registers the worker', () => {
  const { worker, pool } = started();
  assert.deepEqual(worker.launch, LAUNCH);
  assert.equal(pool.has('W1'), true);
  assert.equal(pool.has('W2'), false);
});

test('an error reported by the spawner reaches StartPty.onError as is; the worker stays registered', () => {
  const { worker, pool, errors } = started();
  worker.handlers.onError('pty: kill failed');
  assert.deepEqual(errors, ['pty: kill failed']);
  assert.equal(pool.has('W1'), true, 'only onExit frees the entry');
});

test('exit removes the worker and calls onExit once; later calls report it unknown', async () => {
  const { worker, pool, exits } = started();
  worker.handlers.onExit();
  worker.handlers.onExit();
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.equal(await pool.kill('W1'), false);
  assert.equal(pool.exit('W1'), false);
});

test('exit(ptyId) is the external exit signal (the curl trailer): same effect as the handle exiting, false when unknown', () => {
  const { pool, exits } = started();
  assert.equal(pool.exit('W1'), true);
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.equal(pool.exit('W1'), false);
});

test('kill reaches the handle of a live worker and returns true; the entry stays until the exit', async () => {
  const { worker, pool } = started();
  assert.equal(await pool.kill('W1'), true);
  assert.equal(worker.killed, 1);
  assert.equal(pool.has('W1'), true);
});

test('killAll sends kill to every live worker and skips the ones that already exited', async () => {
  const { spawn, workers } = fakeSpawn();
  const pool = createPtyPool(spawn);
  for (const ptyId of ['W1', 'W2', 'W3']) {
    pool.start({ ptyId, launch: { ...LAUNCH, ptyId }, onExit: noop, onError: noop, onSpawnFailed: noop });
  }
  workers[0].handlers.onExit();
  await pool.killAll();
  assert.deepEqual(workers.map((w) => w.killed), [0, 1, 1]);
});

test('a spawner that reports the exit before returning the handle leaves no entry behind', () => {
  const pool = createPtyPool((_launch, handlers) => {
    handlers.onExit();
    return { started: Promise.resolve(), kill: async () => {} };
  });
  const exits: string[] = [];
  pool.start({ ptyId: 'W1', launch: LAUNCH, onExit: () => exits.push('W1'), onError: noop, onSpawnFailed: noop });
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
});

test('a started that rejects removes the entry and reports onSpawnFailed with the message; neither onExit nor onError fires', async () => {
  const { pool, exits, errors, failures } = started('W1', { startError: 'pty: posix_spawnp failed.' });
  await tick();
  assert.deepEqual(failures, ['pty: posix_spawnp failed.']);
  assert.equal(pool.has('W1'), false);
  assert.deepEqual(exits, []);
  assert.deepEqual(errors, []);
  assert.equal(await pool.kill('W1'), false);
});

test('started resolves once the handle\'s own started resolves, for a spawn with no error (#249)', async () => {
  const { pool } = started();
  await assert.doesNotReject(pool.started('W1'));
});

test('started rejects with the spawner\'s message when the handle\'s started rejects, same as onSpawnFailed (#249)', async () => {
  const { pool } = started('W1', { startError: 'pty: posix_spawnp failed.' });
  await assert.rejects(pool.started('W1'), /pty: posix_spawnp failed\./);
});

test('started rejects for a worker id the pool never started (#249)', async () => {
  const { pool } = started();
  await assert.rejects(pool.started('nope'));
});

test('kill resolves only when the handle kill resolves; killAll waits for every kill', async () => {
  const { spawn, workers } = fakeSpawn({ holdKills: true });
  const pool = createPtyPool(spawn);
  for (const ptyId of ['W1', 'W2']) pool.start({ ptyId, launch: { ...LAUNCH, ptyId }, onExit: noop, onError: noop, onSpawnFailed: noop });
  let killed = false;
  const kill = pool.kill('W1').then((known) => { killed = true; return known; });
  await tick();
  assert.equal(workers[0].killed, 1);
  assert.equal(killed, false, 'the handle has not resolved yet');
  workers[0].releaseKill();
  assert.equal(await kill, true);
  assert.equal(pool.has('W1'), true, 'the entry only leaves on the exit');
  let all = false;
  const killAll = pool.killAll().then(() => { all = true; });
  await tick();
  assert.deepEqual(workers.map((w) => w.killed), [2, 1]);
  assert.equal(all, false, 'W2 is still being killed');
  workers[1].releaseKill();
  await killAll;
  assert.equal(all, true);
});

test('a pty started again in the same id outlives the old one\'s late exit: only the entry that exits leaves (#696)', () => {
  const { pool, workers, exits } = started('T1');
  assert.equal(pool.exit('T1'), true, 'the old one reported gone (the trailer) while its pty still dies');
  pool.start({ ptyId: 'T1', launch: { ...LAUNCH, ptyId: 'T1' }, onExit: () => exits.push('T1 again'), onError: noop, onSpawnFailed: noop });
  workers[0].handlers.onExit(); // the old pty's own exit, late
  assert.deepEqual([pool.has('T1'), exits], [true, ['T1']]);
  workers[1].handlers.onExit();
  assert.deepEqual([pool.has('T1'), exits], [false, ['T1', 'T1 again']]);
});

test('an old start\'s late spawn failure never drops the entry a later start in the same id holds (#696)', async () => {
  let fail: (err: Error) => void = noop;
  const first = new Promise<void>((_resolve, reject) => { fail = reject; });
  const handles = [first, Promise.resolve()];
  const pool = createPtyPool(() => ({ started: handles.shift() ?? Promise.resolve(), kill: async () => undefined }));
  const failures: string[] = [];
  const begin = (): void => pool.start({ ptyId: 'T1', launch: { ...LAUNCH, ptyId: 'T1' }, onExit: noop, onError: noop, onSpawnFailed: (m) => failures.push(m) });
  begin();
  assert.equal(pool.exit('T1'), true);
  begin();
  fail(new Error('pty: gone'));
  await tick();
  assert.deepEqual([pool.has('T1'), failures], [true, ['pty: gone']]);
});
