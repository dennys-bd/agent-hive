import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_MODELS_MAX_AGE_MS, CODEX_MODELS_TIMEOUT_MS, codexModelsCache, parseCodexModels } from '../src/codex-models.js';
import type { Exec } from '../src/types.js';

const LISTED = JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list' }] });
const TERRA = [{ id: 'gpt-5.6-terra', hint: 'GPT-5.6 Terra' }];
const NEWER = JSON.stringify([{ slug: 'gpt-5.7' }]);

// Each call waits for the test to answer it, so a read in flight stays in flight
function heldExec(): { exec: Exec; calls: { file: string; args: string[]; timeout?: number; answer(stdout: string): void; fail(err: Error): void }[] } {
  const calls: ReturnType<typeof heldExec>['calls'] = [];
  const exec: Exec = (file, args, opts) => new Promise((resolve, reject) => {
    calls.push({ file, args, timeout: opts?.timeout, answer: (stdout) => resolve({ stdout }), fail: reject });
  });
  return { exec, calls };
}
// The read's continuation runs on the microtask queue: one macrotask later it has settled
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function clock(): { now(): number; pass(ms: number): void } {
  let at = 0;
  return { now: () => at, pass: (ms) => { at += ms; } };
}
const quiet = { info: (): void => undefined };

test('parseCodexModels lists visible slugs first, hidden after, display_name as the hint; an entry with no usable slug drops (#257)', () => {
  const stdout = JSON.stringify({ models: [
    { slug: 'gpt-old', display_name: 'GPT old', visibility: 'hide' },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list' },
    { slug: '-bad', visibility: 'list' },
    { display_name: 'no slug' },
    { slug: 'gpt-5.6-terra-mini', display_name: 'gpt-5.6-terra-mini', visibility: 'list' },
  ] });
  assert.deepEqual(parseCodexModels(stdout), [{ id: 'gpt-5.6-terra', hint: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-terra-mini' }, { id: 'gpt-old', hint: 'GPT old' }]);
  assert.deepEqual(parseCodexModels(JSON.stringify([{ slug: 'gpt-x' }])), [{ id: 'gpt-x' }], 'a bare list reads too');
  assert.throws(() => parseCodexModels('not json'));
});

test('the cache reads codex debug models once at creation; list() answers [] until it lands and starts no second read meanwhile; a first success logs nothing (#694)', async () => {
  const { exec, calls } = heldExec();
  const lines: string[] = [];
  const cache = codexModelsCache(exec, { info: (line) => { lines.push(line); } }, clock().now);
  assert.deepEqual(calls.map((c) => [c.file, c.args, c.timeout]), [['codex', ['debug', 'models'], CODEX_MODELS_TIMEOUT_MS]]);
  assert.deepEqual(cache.list(), []);
  assert.equal(calls.length, 1, 'a read in flight: none started');
  calls[0].answer(LISTED);
  await settled();
  assert.deepEqual(cache.list(), TERRA);
  assert.equal(calls.length, 1, 'a fresh list: no read');
  assert.deepEqual(lines, []);
});

test('a list older than the max age answers at once and starts one background read; a second list() meanwhile starts none (#694)', async () => {
  const { exec, calls } = heldExec();
  const time = clock();
  const cache = codexModelsCache(exec, quiet, time.now);
  calls[0].answer(LISTED);
  await settled();
  time.pass(CODEX_MODELS_MAX_AGE_MS + 1);
  assert.deepEqual(cache.list(), TERRA, 'the old list, at once');
  cache.list();
  assert.equal(calls.length, 2, 'one read for the two opens');
  calls[1].answer(NEWER);
  await settled();
  assert.deepEqual(cache.list(), [{ id: 'gpt-5.7' }]);
});

test('a failed refresh keeps the last list and its age, so the next stale list() tries again (#694)', async () => {
  const { exec, calls } = heldExec();
  const time = clock();
  const cache = codexModelsCache(exec, quiet, time.now);
  calls[0].answer(LISTED);
  await settled();
  time.pass(CODEX_MODELS_MAX_AGE_MS + 1);
  cache.list();
  calls[1].fail(new Error('timed out'));
  await settled();
  assert.deepEqual(cache.list(), TERRA);
  assert.equal(calls.length, 3, 'still stale: this open retries');
});

test('hive.log gets a line when the outcome changes: two failures in a row log once, the success after them once (#694)', async () => {
  const { exec, calls } = heldExec();
  const lines: string[] = [];
  const cache = codexModelsCache(exec, { info: (line) => { lines.push(line); } }, clock().now);
  calls[0].fail(new Error('codex: command not found\n    at spawn'));
  await settled();
  cache.list(); // no good read yet: stale
  calls[1].fail(new Error('codex: command not found'));
  await settled();
  assert.deepEqual(lines, ['launch options: codex debug models gave no list: codex: command not found']);
  cache.list();
  calls[2].answer(LISTED);
  await settled();
  assert.deepEqual(lines.slice(1), ['launch options: codex debug models lists Codex\'s models again']);
});
