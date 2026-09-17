import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPool, RESULT_LINE } from '../src/workers.js';
import { OUTPUT_LINES } from '../src/transcript.js';
import { fakeSpawn, LAUNCH } from './fakes.js';

const noop = (): void => {};

const assistant = (...content: unknown[]): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });

function started(workerId = 'W1', withFocus = false) {
  const { spawn, workers } = fakeSpawn(withFocus);
  const pool = createWorkerPool(spawn);
  const exits: string[] = [];
  const results: [string, string][] = [];
  pool.start({
    workerId, launch: { ...LAUNCH, workerId },
    onExit: () => exits.push(workerId), onResult: (id, text) => results.push([id, text]),
  });
  return { pool, worker: workers[0], workers, exits, results };
}

test('start hands the launch to the spawner (the prompt goes in as the spawner sees fit) and registers the worker', () => {
  const { worker, pool } = started();
  assert.deepEqual(worker.launch, LAUNCH);
  assert.deepEqual(worker.sent, [], 'the pool itself sends nothing');
  assert.equal(pool.has('W1'), true);
  assert.equal(pool.has('W2'), false);
});

test('output keeps the last 200 formatted lines and returns a copy', () => {
  const { worker, pool } = started();
  for (let i = 0; i < OUTPUT_LINES + 5; i += 1) worker.handlers.onLine(`line ${i}`);
  const lines = pool.output('W1');
  assert.equal(lines.length, OUTPUT_LINES);
  assert.equal(lines[0], 'line 5');
  assert.equal(lines.at(-1), `line ${OUTPUT_LINES + 4}`);
  lines.push('mutated');
  assert.equal(pool.output('W1').length, OUTPUT_LINES);
  assert.deepEqual(pool.output('nope'), []);
});

test('a result line calls onResult with the worker id and the final text; other lines do not', () => {
  const { worker, results } = started();
  worker.handlers.onLine(assistant({ type: 'text', text: 'oi' }));
  worker.handlers.onLine(JSON.stringify({ type: 'system' }));
  worker.handlers.onLine('not json');
  assert.deepEqual(results, []);
  worker.handlers.onLine(JSON.stringify({ type: 'result', result: 'Posso apagar o arquivo?' }));
  assert.deepEqual(results, [['W1', 'Posso apagar o arquivo?']]);
  worker.handlers.onLine(JSON.stringify({ type: 'result' }));
  assert.deepEqual(results.at(-1), ['W1', ''], 'no result text: empty string, never undefined');
});

test('exit removes the worker and calls onExit; later calls report it unknown', () => {
  const { worker, pool, exits } = started();
  worker.handlers.onLine('hello');
  worker.handlers.onExit();
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.deepEqual(pool.output('W1'), []);
  assert.equal(pool.send('W1', 'x'), false);
  assert.equal(pool.end('W1'), false);
  assert.equal(pool.kill('W1'), false);
  assert.deepEqual(worker.sent, [], 'nothing written after the exit');
});

test('exit(workerId) is the external exit signal (a tab that ended): same effect as the handle exiting, false when unknown', () => {
  const { pool, exits } = started();
  assert.equal(pool.exit('W1'), true);
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.equal(pool.exit('W1'), false);
});

test('focus reaches the handle when it has one; false for a handle without focus or an unknown worker', async () => {
  const withFocus = started('W1', true);
  assert.equal(await withFocus.pool.focus('W1'), true);
  assert.equal(withFocus.worker.focused, 1);
  const embedded = started();
  assert.equal(await embedded.pool.focus('W1'), false);
  assert.equal(await embedded.pool.focus('nope'), false);
});

test('send, end and kill reach the handle of a live worker and return true', () => {
  const { worker, pool } = started();
  assert.equal(pool.send('W1', 'continua'), true);
  assert.equal(pool.end('W1'), true);
  assert.equal(pool.kill('W1'), true);
  assert.deepEqual(worker.sent, ['continua']);
  assert.equal(worker.ended, 1);
  assert.equal(worker.killed, 1);
});

test('killAll sends kill to every live worker and skips the ones that already exited', () => {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  for (const workerId of ['W1', 'W2', 'W3']) {
    pool.start({ workerId, launch: { ...LAUNCH, workerId }, onExit: noop, onResult: noop });
  }
  workers[0].handlers.onExit();
  pool.killAll();
  assert.deepEqual(workers.map((w) => w.killed), [0, 1, 1]);
});

test('send after end reports the worker as gone: stdin is closed even though the process is still exiting', () => {
  const { pool, worker } = started();
  assert.equal(pool.end('W1'), true);
  assert.equal(pool.send('W1', 'mais uma'), false);
  assert.deepEqual(worker.sent, [], 'nothing is written to a closed stdin');
  assert.equal(pool.has('W1'), true, 'the entry stays until the exit so its output is still readable');
});

test('a spawner that reports the exit before returning the handle leaves no entry behind', () => {
  const pool = createWorkerPool((_launch, handlers) => {
    handlers.onExit();
    return { send: noop, end: noop, kill: noop };
  });
  const exits: string[] = [];
  pool.start({ workerId: 'W1', launch: LAUNCH, onExit: () => exits.push('W1'), onResult: noop });
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
});
