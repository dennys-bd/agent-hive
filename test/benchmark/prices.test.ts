import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { costOf, type Price, PRICES, readModelTokens } from '../../src/benchmark/prices.js';
import { type FactRecord, SCHEMA_VERSION, type Tokens, ZERO_TOKENS } from '../../src/facts.js';
import { openUsageStore, USAGE_FILE } from '../../src/usage-store.js';
import { fakeLog } from '../fakes.js';
import { tempDir } from '../temp-dir.js';

// Placeholder prices, so the arithmetic is checked apart from the published table
const TABLE: Record<string, Price> = {
  'model-a': { input: 1, output: 2, cache_write: 3, cache_read: 4 },
  'model-a-long': { input: 10, output: 20, cache_write: 30, cache_read: 40 },
  'model-b': { input: 5, output: 6, cache_write: 7, cache_read: 8 },
};
const M = 1_000_000;
const tokens = (input: number, output = 0, cacheWrite = 0, cacheRead = 0): Tokens => ({ input, output, cache_write: cacheWrite, cache_read: cacheRead });
const CURRENT_CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const TS = '2026-10-21T12:00:00.000Z';
const ended = (byModel: Record<string, Tokens>): FactRecord => ({
  schema_version: SCHEMA_VERSION, ts: TS, event: 'stage.ended', level: 'info', task_id: 'local:1', stage: 'Build', agent: 'claude', outcome: 'done',
  duration_ms: 60_000, waited_ms: 0, tokens: ZERO_TOKENS, subagent_tokens: ZERO_TOKENS, models: Object.keys(byModel), tokens_by_model: byModel, tool_counts: {},
});

test('costOf prices each model per token type and sums them (#473)', () => {
  const byModel = { 'model-a': tokens(M, 2 * M, 0, M), 'model-b': tokens(0, M, M, 0) };
  assert.deepEqual(costOf(byModel, TABLE), { usd: 1 + 4 + 4 + 6 + 7, unpriced: [] });
});

test('costOf prices a dated id as the longest table id it extends with a dash, never an id it only starts with (#473)', () => {
  assert.deepEqual(costOf({ 'model-a-20261001': tokens(M) }, TABLE), { usd: 1, unpriced: [] });
  assert.deepEqual(costOf({ 'model-a-long-20261001': tokens(M) }, TABLE), { usd: 10, unpriced: [] });
  assert.deepEqual(costOf({ 'model-ab': tokens(M) }, TABLE), { usd: 0, unpriced: ['model-ab'] });
});

test('costOf costs unknown and an off-table model 0 and lists them in unpriced (#473)', () => {
  assert.deepEqual(costOf({ unknown: tokens(M), 'model-b': tokens(M), 'model-z': tokens(0, M) }, TABLE), { usd: 5, unpriced: ['unknown', 'model-z'] });
});

test('PRICES prices every current Claude model, each token type a positive USD per million, and costOf reads it by default (#473)', () => {
  for (const id of CURRENT_CLAUDE) {
    const price = PRICES[id];
    assert.ok(price, id);
    for (const value of Object.values(price)) assert.ok(Number.isFinite(value) && value > 0, id);
  }
  assert.equal(costOf({ 'claude-opus-5-5': tokens(M) }).usd, PRICES['claude-opus-5-5'].input);
});

test('readModelTokens sums tokens_by_model over the stage.ended rows only, and a home without usage.sqlite reads as none and gets no file (#473)', async (t) => {
  const home = await tempDir(t, 'prices-');
  assert.deepEqual(await readModelTokens(home), {});
  assert.equal(existsSync(join(home, USAGE_FILE)), false, 'a read never creates the store');
  const store = await openUsageStore(home, fakeLog().log);
  store.write(ended({ 'model-a': tokens(1, 2, 3, 4), 'model-b': tokens(10) }));
  store.write(ended({ 'model-a': tokens(100, 200, 300, 400) }));
  store.write({ schema_version: SCHEMA_VERSION, ts: TS, event: 'free_session.ended', level: 'info', duration_ms: 1, worker: 1, tokens_by_model: { 'model-a': tokens(9_999) } });
  store.close();
  assert.deepEqual(await readModelTokens(home), { 'model-a': tokens(101, 202, 303, 404), 'model-b': tokens(10) });
});
