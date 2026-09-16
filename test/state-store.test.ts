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
