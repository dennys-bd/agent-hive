import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { loadState, saveState } from '../src/state-store.js';

test('loadState returns initialState when nothing is saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const state = await loadState(dir, 3);
  assert.equal(state.slots.length, 3);
  assert.deepEqual(state.queue, []);
});

test('saveState then loadState round-trips and leaves no tmp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const state = { ...initialState(1), error: 'x' };
  await saveState(dir, state);
  assert.deepEqual(await loadState(dir, 1), state);
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('loadState ignores a corrupt file and falls back to initialState', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  await writeFile(join(dir, 'state.json'), '{not json');
  const state = await loadState(dir, 2);
  assert.equal(state.slots.length, 2);
});

test('loadState reads a missing or unknown signal as green and keeps a valid one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const legacy = { maxConcurrent: 1, slots: [], queue: [] }; // written before the signal existed
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  assert.equal((await loadState(dir, 1)).signal, 'green');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, signal: 'red' }));
  assert.equal((await loadState(dir, 1)).signal, 'red');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, signal: 'blue' }));
  assert.equal((await loadState(dir, 1)).signal, 'green');
});

test('loadState reads missing usage and budget as empty, keeps valid samples and drops malformed ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const legacy = { signal: 'green', maxConcurrent: 1, slots: [], queue: [] }; // written before the budget existed
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  const loaded = await loadState(dir, 1);
  assert.deepEqual(loaded.usage, []);
  assert.deepEqual(loaded.budget, {});
  assert.deepEqual(loaded.usageRules, []);
  const valid = { at: '2026-09-16T12:00:00.000Z', tokens: 1200 };
  const usage = [valid, { at: 5, tokens: 1 }, { at: '2026-09-16T12:00:00.000Z' }, { at: 'x', tokens: 'many' }, null, 7];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usage, budget: { maxTokensPerHour: 10 } }));
  const kept = await loadState(dir, 1);
  assert.deepEqual(kept.usage, [valid]);
  assert.deepEqual(kept.budget, { maxTokensPerHour: 10 });
  const usageRules = [{ percent: 80, signal: 'yellow' }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usageRules }));
  assert.deepEqual((await loadState(dir, 1)).usageRules, usageRules);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usage: 'nope' }));
  assert.deepEqual((await loadState(dir, 1)).usage, []);
});
