import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBoardText } from '../src/boards/markdown.js';
import { bootHive } from '../src/hive.js';
import { initialState } from '../src/orchestrator.js';
import { saveState } from '../src/state-store.js';
import type { SetupInfo } from '../src/types.js';

// Markdown board, zero slots and port 0 (random free port): boots without gh, a claude process or a fixed port.
async function repoWithConfig(extra: Record<string, unknown>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-boot-'));
  await writeFile(join(repo, 'board.md'), newBoardText());
  const config = { board: { type: 'markdown', path: 'board.md' }, maxConcurrent: 0, port: 0, ...extra };
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify(config));
  return repo;
}

test('bootHive copies the budget from hive.config.json over the one saved in state.json', async (t) => {
  const repo = await repoWithConfig({ budget: { maxTokensPerHour: 50_000 } });
  await mkdir(join(repo, '.hive'));
  await saveState(join(repo, '.hive'), { ...initialState(0), budget: { maxTokensPerDay: 1 } }); // stale copy from a previous run
  const { server } = await bootHive(repo);
  t.after(() => server.close());
  assert.deepEqual(server.getState()?.budget, { maxTokensPerHour: 50_000 });
});

test('bootHive opens under yellow even when state.json saved green, and under red when it saved red', async (t) => {
  const repoGreen = await repoWithConfig({});
  await mkdir(join(repoGreen, '.hive'));
  await saveState(join(repoGreen, '.hive'), { ...initialState(0), signal: 'green' });
  const green = await bootHive(repoGreen);
  t.after(() => green.server.close());
  assert.equal(green.server.getState()?.signal, 'yellow');

  const repoRed = await repoWithConfig({});
  await mkdir(join(repoRed, '.hive'));
  await saveState(join(repoRed, '.hive'), { ...initialState(0), signal: 'red' });
  const red = await bootHive(repoRed);
  t.after(() => red.server.close());
  assert.equal(red.server.getState()?.signal, 'red');
});

test('bootHive falls back to setup mode when the configured board is unusable', async (t) => {
  const repo = await repoWithConfig({});
  await rm(join(repo, 'board.md')); // the board file was deleted after the config was written
  const { server, port } = await bootHive(repo);
  t.after(() => server.close());
  const info = await (await fetch(`http://127.0.0.1:${port}/setup`)).json() as SetupInfo;
  assert.equal(info.configured, false);
  assert.equal(info.config?.board.type, 'markdown'); // the form reopens prefilled with what was saved
  assert.match(info.error ?? '', /board\.md não existe/);
});
