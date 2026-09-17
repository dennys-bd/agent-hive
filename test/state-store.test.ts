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
  const rule = { percent: 80, signal: 'yellow' };
  const usageRules = [rule, { percent: 'x', signal: 'red' }, { percent: 50 }, { percent: 50, signal: 'blue' }, null, 7];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usageRules }));
  assert.deepEqual((await loadState(dir, 1)).usageRules, [rule], 'malformed rules are dropped');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usage: 'nope' }));
  assert.deepEqual((await loadState(dir, 1)).usage, []);
});

test('loadState keeps a valid rateLimits reading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const rateLimits = {
    at: '2026-09-16T12:00:00.000Z',
    windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-16T15:00:00.000Z' }, seven_day_fable: { usedPercent: 7, resetsAt: '2026-09-20T00:00:00.000Z' } },
  };
  await saveState(dir, { ...initialState(1), rateLimits });
  assert.deepEqual((await loadState(dir, 1)).rateLimits, rateLimits);
});

test('loadState drops a rateLimits with the wrong shape and leaves the key absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const base = initialState(1);
  const at = '2026-09-16T12:00:00.000Z';
  const bad: unknown[] = [
    5, 'x', null, [], { at: 5, windows: {} }, { at }, { at, windows: [] }, { at, windows: 'x' },
    { at, windows: { five_hour: { usedPercent: 'many', resetsAt: at } } },
    { at, windows: { five_hour: { usedPercent: 1, resetsAt: 7 } } },
    { at, windows: { five_hour: null } },
  ];
  for (const rateLimits of bad) {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...base, rateLimits }));
    const loaded = await loadState(dir, 1);
    assert.equal('rateLimits' in loaded, false, JSON.stringify(rateLimits));
  }
});
