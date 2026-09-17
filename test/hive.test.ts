import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBoardText } from '../src/boards/markdown.js';
import { bootHive } from '../src/hive.js';
import { initialState } from '../src/orchestrator.js';
import { saveState } from '../src/state-store.js';
import type { RateLimits, SetupInfo } from '../src/types.js';
import { COLUMNS } from './fakes.js';

// Markdown board, zero slots and port 0 (random free port): boots without gh, a claude process or a fixed port.
async function repoWithConfig(extra: Record<string, unknown>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-boot-'));
  await writeFile(join(repo, 'board.md'), newBoardText());
  const config = { board: { type: 'markdown', path: 'board.md' }, columns: COLUMNS, maxConcurrent: 0, port: 0, ...extra };
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

const logLines = async (repo: string): Promise<string[]> =>
  (await readFile(join(repo, '.hive', 'hive.log'), 'utf8')).split('\n').filter(Boolean).map((l) => l.slice(25)); // drop the ISO stamp

test('bootHive writes the boot to <repo>/.hive/hive.log: mode=hive with a usable board, mode=setup with the reason when it is not', async (t) => {
  const repo = await repoWithConfig({});
  const hive = await bootHive(repo);
  t.after(() => hive.server.close());
  const lines = await logLines(repo);
  assert.ok(lines.includes(`INFO  boot repo=${repo} mode=hive`), lines.join('\n'));
  assert.ok(lines.includes(`INFO  listening port=${hive.port}`));
  assert.ok(lines.includes('INFO  poll queue=0')); // newBoardText's example row is status Done, not the queue column
  assert.ok(!lines.some((l) => l.startsWith('DEBUG')), 'default level is info');

  const broken = await repoWithConfig({ logLevel: 'debug' });
  await rm(join(broken, 'board.md'));
  const setup = await bootHive(broken); // prints the board error on stderr too, as the spec wants for error
  t.after(() => setup.server.close());
  const setupLines = await logLines(broken);
  assert.ok(setupLines.some((l) => l.startsWith('ERROR board: ') && l.includes('board.md não existe')), setupLines.join('\n'));
  assert.ok(setupLines.some((l) => l.startsWith(`INFO  boot repo=${broken} mode=setup reason=`) && l.includes('board.md não existe')));
});

test('bootHive logs a hive.config.json that cannot be parsed before rethrowing, so a broken boot leaves a trace', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-boot-'));
  await writeFile(join(repo, 'hive.config.json'), '{ not json');
  await assert.rejects(bootHive(repo), /JSON inválido/);
  const lines = await logLines(repo);
  assert.ok(lines.some((l) => l.startsWith('ERROR config: ') && l.includes('JSON inválido')), lines.join('\n'));
});

const setupInfo = async (port: number): Promise<SetupInfo> => (await fetch(`http://127.0.0.1:${port}/setup`)).json() as Promise<SetupInfo>;

test('bootHive turns the locale into the system language: pt-BR without a config language gives pt, the config wins when set, and setup mode carries it too', async (t) => {
  const pt = await bootHive(await repoWithConfig({}), { locale: 'pt-BR' });
  t.after(() => pt.server.close());
  assert.equal((await setupInfo(pt.port)).language, 'pt');
  const en = await bootHive(await repoWithConfig({ language: 'en' }), { locale: 'pt-BR' });
  t.after(() => en.server.close());
  assert.equal((await setupInfo(en.port)).language, 'en', 'the config wins over the system');
  const broken = await repoWithConfig({});
  await rm(join(broken, 'board.md')); // setup fallback: port 0 comes from the saved config, so no fixed port is touched
  const setup = await bootHive(broken, { locale: 'en-US' });
  t.after(() => setup.server.close());
  assert.equal((await setupInfo(setup.port)).language, 'en');
});

test('bootHive reads the plan limits through the injected reader on boot, so the header has them before any worker; no reader, no reading', async (t) => {
  const repo = await repoWithConfig({});
  const rateLimits: RateLimits = { at: '2026-09-17T12:00:00.000Z', windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-17T15:00:00.000Z' } } };
  let reads = 0;
  const { server } = await bootHive(repo, { readPlanLimits: async () => { reads += 1; return rateLimits; } });
  t.after(() => server.close());
  assert.equal(reads, 1);
  assert.deepEqual(server.getState()?.rateLimits, rateLimits);
  const plain = await repoWithConfig({});
  const bare = await bootHive(plain);
  t.after(() => bare.server.close());
  assert.equal(bare.server.getState()?.rateLimits, undefined);
  assert.ok(!(await logLines(plain)).some((l) => l.includes('plan limits')), 'nothing to say without a reader');
});
