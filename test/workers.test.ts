import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPool, formatOutput, OUTPUT_LINES, RESULT_LINE } from '../src/workers.js';
import { fakeSpawn } from './fakes.js';

const ENV: NodeJS.ProcessEnv = { HIVE_WORKER_ID: 'W1', HIVE_PORT: '4242' };
const noop = (): void => {};

const assistant = (...content: unknown[]): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });

function started(workerId = 'W1') {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  const exits: string[] = [];
  const results: string[] = [];
  pool.start({
    workerId, argv: ['-p'], cwd: '/repo', env: ENV, prompt: 'faz a task',
    onExit: () => exits.push(workerId), onResult: (id) => results.push(id),
  });
  return { pool, worker: workers[0], workers, exits, results };
}

test('formatOutput shows assistant text blocks and tool calls with their main argument', () => {
  const line = assistant(
    { type: 'text', text: 'vou olhar o arquivo' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'roda os testes' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
    { type: 'tool_use', name: 'Task', input: { description: 'explora o repo' } },
    { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
  );
  assert.deepEqual(formatOutput(line), [
    'vou olhar o arquivo', '▶ Read: /repo/src/a.ts', '▶ Bash: pnpm test', '▶ Grep: TODO', '▶ Task: explora o repo', '▶ TodoWrite',
  ]);
});

test('formatOutput truncates text to 2000 chars and tool arguments to 120', () => {
  const [text, tool] = formatOutput(
    assistant({ type: 'text', text: 'x'.repeat(2500) }, { type: 'tool_use', name: 'Bash', input: { command: 'y'.repeat(300) } }),
  );
  assert.equal(text.length, 2000);
  assert.equal(tool, `▶ Bash: ${'y'.repeat(120)}`);
});

test('formatOutput marks a result, hides system / user / stream_event lines and passes non-JSON through', () => {
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'result', subtype: 'success' })), [RESULT_LINE]);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'system', subtype: 'init' })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'stream_event' })), []);
  assert.deepEqual(formatOutput('stderr: warning: something'), ['stderr: warning: something']);
  assert.deepEqual(formatOutput('42'), ['42']);
  assert.deepEqual(formatOutput(''), ['']);
});

test('start opens the process with argv, cwd and env and sends the prompt as the first message', () => {
  const { worker, pool } = started();
  assert.deepEqual(worker.argv, ['-p']);
  assert.deepEqual(worker.opts, { cwd: '/repo', env: ENV });
  assert.deepEqual(worker.sent, ['faz a task']);
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

test('a result line calls onResult with the worker id; other lines do not', () => {
  const { worker, results } = started();
  worker.handlers.onLine(assistant({ type: 'text', text: 'oi' }));
  worker.handlers.onLine(JSON.stringify({ type: 'system' }));
  worker.handlers.onLine('not json');
  assert.deepEqual(results, []);
  worker.handlers.onLine(JSON.stringify({ type: 'result' }));
  assert.deepEqual(results, ['W1']);
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
  assert.deepEqual(worker.sent, ['faz a task'], 'nothing written after the exit');
});

test('send, end and kill reach the handle of a live worker and return true', () => {
  const { worker, pool } = started();
  assert.equal(pool.send('W1', 'continua'), true);
  assert.equal(pool.end('W1'), true);
  assert.equal(pool.kill('W1'), true);
  assert.deepEqual(worker.sent, ['faz a task', 'continua']);
  assert.equal(worker.ended, 1);
  assert.equal(worker.killed, 1);
});

test('killAll sends kill to every live worker and skips the ones that already exited', () => {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  for (const workerId of ['W1', 'W2', 'W3']) {
    pool.start({ workerId, argv: [], cwd: '/repo', env: ENV, prompt: 'p', onExit: noop, onResult: noop });
  }
  workers[0].handlers.onExit();
  pool.killAll();
  assert.deepEqual(workers.map((w) => w.killed), [0, 1, 1]);
});
