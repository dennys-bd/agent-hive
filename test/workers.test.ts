import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPool } from '../src/workers.js';
import { fakeSpawn, LAUNCH } from './fakes.js';

const noop = (): void => {};

function started(workerId = 'W1') {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  const exits: string[] = [];
  const errors: string[] = [];
  pool.start({ workerId, launch: { ...LAUNCH, workerId }, onExit: () => exits.push(workerId), onError: (message) => errors.push(message) });
  return { pool, worker: workers[0], workers, exits, errors };
}

test('start hands the launch to the spawner and registers the worker', () => {
  const { worker, pool } = started();
  assert.deepEqual(worker.launch, LAUNCH);
  assert.equal(pool.has('W1'), true);
  assert.equal(pool.has('W2'), false);
});

test('an error reported by the spawner reaches StartWorker.onError as is; the worker stays registered', () => {
  const { worker, pool, errors } = started();
  worker.handlers.onError('tmux: spawn tmux ENOENT');
  assert.deepEqual(errors, ['tmux: spawn tmux ENOENT']);
  assert.equal(pool.has('W1'), true, 'only onExit frees the entry');
});

test('exit removes the worker and calls onExit once; later calls report it unknown', () => {
  const { worker, pool, exits } = started();
  worker.handlers.onExit();
  worker.handlers.onExit();
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.equal(pool.kill('W1'), false);
  assert.equal(pool.exit('W1'), false);
});

test('exit(workerId) is the external exit signal (the curl trailer): same effect as the handle exiting, false when unknown', () => {
  const { pool, exits } = started();
  assert.equal(pool.exit('W1'), true);
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.equal(pool.exit('W1'), false);
});

test('kill reaches the handle of a live worker and returns true; the entry stays until the exit', () => {
  const { worker, pool } = started();
  assert.equal(pool.kill('W1'), true);
  assert.equal(worker.killed, 1);
  assert.equal(pool.has('W1'), true);
});

test('focus awaits the handle and returns true; false for an unknown worker; a failing terminal rejects', async () => {
  const { worker, pool } = started();
  assert.equal(await pool.focus('W1'), true);
  assert.equal(worker.focused, 1);
  assert.equal(await pool.focus('nope'), false);
  worker.focusError = new Error('terminal não suportado em win32');
  await assert.rejects(pool.focus('W1'), /win32/);
});

test('killAll sends kill to every live worker and skips the ones that already exited', () => {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  for (const workerId of ['W1', 'W2', 'W3']) {
    pool.start({ workerId, launch: { ...LAUNCH, workerId }, onExit: noop, onError: noop });
  }
  workers[0].handlers.onExit();
  pool.killAll();
  assert.deepEqual(workers.map((w) => w.killed), [0, 1, 1]);
});

test('a spawner that reports the exit before returning the handle leaves no entry behind', () => {
  const pool = createWorkerPool((_launch, handlers) => {
    handlers.onExit();
    return { kill: noop, focus: async () => {} };
  });
  const exits: string[] = [];
  pool.start({ workerId: 'W1', launch: LAUNCH, onExit: () => exits.push('W1'), onError: noop });
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
});
