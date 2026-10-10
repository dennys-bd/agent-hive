import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { loadState } from '../../src/state-store.js';
import { runConfig, runState } from '../../scripts/experiment/arm-config.js';
import { prepareState, writeHome } from '../../scripts/experiment/run-home.js';
import { tempDir } from '../temp-dir.js';
import { BRANCH, PATHS, PREFIX, STAGES, TASKS, WORKSPACE } from './fixtures.js';

test('writeHome writes a home the daemon boots from: config and state parse, home 0700, files 0600, nothing left from before (#105)', async (t) => {
  const home = join(await tempDir(t, 'home-'), 'home');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'hive.log'), 'old');
  await writeHome(home, runConfig(STAGES, 'a', BRANCH, WORKSPACE, PREFIX, PATHS), runState(TASKS, 'Spec', PREFIX));
  assert.equal((await loadConfig(home)).baseBranch, BRANCH);
  assert.equal((await loadState(home)).tasks.length, 3);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  for (const name of ['hive.config.json', 'state.json']) assert.equal((await stat(join(home, name))).mode & 0o777, 0o600, name);
  assert.equal(existsSync(join(home, 'hive.log')), false);
});

test('prepareState makes the state folder and its homes and experiments folders 0700, and keeps them so on a second call (#105)', async (t) => {
  const state = join(await tempDir(t, 'state-'), 'agent-hive-lab');
  await prepareState(state);
  await prepareState(state);
  for (const dir of [state, join(state, 'homes'), join(state, 'experiments')]) assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
});
