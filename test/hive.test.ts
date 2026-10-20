import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readDaemonSecret } from '../src/daemon-files.js';
import { bootHive } from '../src/hive.js';
import { initialState } from '../src/orchestrator.js';
import { READ_MODEL_FILE } from '../src/read-model/db.js';
import type { ItemStore } from '../src/read-model/items.js';
import { SECRET_HEADER } from '../src/secret.js';
import { saveState } from '../src/state-store.js';
import { USAGE_FILE } from '../src/usage-store.js';
import type { AgentAvailability, RateLimits, SettingsInfo, Source, SourceItem, SourceSpec, Task } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, SIDEBARS_PER_VIEW_DEFAULTS, SIGNALS_DEFAULTS, VIEWER_DEFAULTS, MCP_DEFAULTS } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, LOCAL_STAGES, STAGES, combConfig, fakeSourceFactory, tempHive, claudePlan } from './fakes.js';
import { settingsBody } from './review-server.js';
import { tempDir, type AfterHost } from './temp-dir.js';

// A home with a Comb on a temp git repo: no source, zero workers, a port of its own (#466), so it boots without gh or a claude
// process. The repo starts empty: whatever lands in it is the Hive writing where it should not.
async function hiveWithConfig(t: AfterHost, extra: Record<string, unknown>): Promise<{ home: string; repo: string }> {
  const { home, repo } = await tempHive(t);
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(combConfig({ stages: LOCAL_STAGES, path: repo, ...extra })));
  return { home, repo };
}

// A saved source that cannot be read, like a GitHub Project that is gone (#180): what sends a saved Comb back to the setup form. bootHive
// builds it through the injected factory, so no gh runs.
const UNREADABLE = 'source not found: no GitHub Project 6 for "acme"';
const unreadable = (spec: SourceSpec): Source => ({ ...fakeSourceFactory().factory(spec), resolveFields: () => Promise.reject(new Error(UNREADABLE)) });
const WITH_SOURCE = { sources: [GITHUB_ENTRY], stages: STAGES };

const logLines = async (home: string): Promise<string[]> =>
  (await readFile(join(home, 'hive.log'), 'utf8')).split('\n').filter(Boolean).map((l) => l.slice(25)); // drop the ISO stamp

// A client of the booted daemon (#467): the secret bootHive wrote to the home, read the way every real client reads it
const asClient = (home: string): Record<string, string> => ({ [SECRET_HEADER]: readDaemonSecret(home) ?? '' });
const settingsInfo = async (home: string, port: number): Promise<SettingsInfo> =>
  (await fetch(`http://127.0.0.1:${port}/settings`, { headers: asClient(home) })).json() as Promise<SettingsInfo>;
const postStop = (home: string, port: number): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', headers: { ...asClient(home), 'x-hive-ui': '1' } });

// Rewrites every workspace of a saved hive.config.json, as a file from before a workspace key (#300, #348) would read.
async function rewriteWorkspaces(home: string, patch: (workspace: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await rewriteComb(home, (comb) => ({ ...comb, workspaces: (comb.workspaces as Record<string, unknown>[]).map(patch) }));
}

async function rewriteComb(home: string, patch: (comb: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const file = join(home, 'hive.config.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as { comb: Record<string, unknown> };
  await writeFile(file, JSON.stringify({ ...saved, comb: patch(saved.comb) }));
}

test('bootHive copies the budget from hive.config.json over the one saved in state.json', async (t) => {
  const { home } = await hiveWithConfig(t, { budget: { maxTokensPerHour: 50_000 } });
  await saveState(home, { ...initialState(0), budget: { maxTokensPerDay: 1 } }); // stale copy from a previous run
  const { server } = await bootHive(home);
  t.after(() => server.close());
  assert.deepEqual(server.getState()?.budget, { maxTokensPerHour: 50_000 });
});

test('bootHive opens under yellow even when state.json saved green, and under red when it saved red', async (t) => {
  const { home: homeGreen } = await hiveWithConfig(t, {});
  await saveState(homeGreen, { ...initialState(0), signal: 'green' });
  const green = await bootHive(homeGreen);
  t.after(() => green.server.close());
  assert.equal(green.server.getState()?.signal, 'yellow');

  const { home: homeRed } = await hiveWithConfig(t, {});
  await saveState(homeRed, { ...initialState(0), signal: 'red' });
  const red = await bootHive(homeRed);
  t.after(() => red.server.close());
  assert.equal(red.server.getState()?.signal, 'red');
});

test('bootHive falls back to setup mode when the configured source is unusable', async (t) => {
  const { home } = await hiveWithConfig(t, WITH_SOURCE);
  const { server, port } = await bootHive(home, { sourceFactory: unreadable });
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.deepEqual(info.config?.comb.sources, [GITHUB_ENTRY]); // the form reopens prefilled with what was saved
  assert.equal(info.error, `source board: ${UNREADABLE}`);
  assert.equal(info.proposedWorkspace, undefined, 'a saved config prefills the form: nothing is proposed');
});

test('bootHive opens the read model before the boot adapters and hands it to each; a fallback to setup mode keeps it for the next save (#190, #401)', async (t) => {
  const stores: (ItemStore | undefined)[] = [];
  const recording = (build: (spec: SourceSpec) => Source) => (spec: SourceSpec, items?: ItemStore): Source => {
    stores.push(items);
    return build(spec);
  };
  const { home } = await hiveWithConfig(t, WITH_SOURCE);
  const hive = await bootHive(home, { sourceFactory: recording(fakeSourceFactory().factory) });
  t.after(() => hive.server.close());
  assert.deepEqual(stores[0]?.db.listing('github:github.com:bia', 'acme/6'), [], 'open: it answers a read');

  const broken = await hiveWithConfig(t, WITH_SOURCE);
  const setup = await bootHive(broken.home, { sourceFactory: recording(unreadable) });
  t.after(() => setup.server.close()); // a second close() is a no-op: this one only covers a failed assertion
  const kept = stores.at(-1);
  assert.ok(kept !== undefined, 'the boot adapter got the store');
  assert.deepEqual(kept.db.listing('github:github.com:bia', 'acme/6'), [], 'open: leaving setup mode by a save reads it');
  await setup.server.close();
  assert.throws(() => kept.db.listing('github:github.com:bia', 'acme/6'), 'the server closes it');
});

test('bootHive in setup mode hands the read model to the first Settings save, so leaving setup mode needs no restart (#401)', async (t) => {
  const stores: (ItemStore | undefined)[] = [];
  const { home, repo } = await tempHive(t); // no hive.config.json: setup mode
  const setup = await bootHive(home, {
    sourceFactory: (spec, items) => {
      stores.push(items);
      return fakeSourceFactory().factory(spec);
    },
  });
  t.after(() => setup.server.close());
  const body = { ...settingsBody(repo, STAGES), auth: AUTH, sources: [GITHUB_ENTRY] };
  const saved = await fetch(`http://127.0.0.1:${setup.port}/settings`, { method: 'POST', headers: { ...asClient(home), 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body) });
  assert.equal(saved.status, 200, await saved.text());
  assert.equal((await settingsInfo(home, setup.port)).configured, true);
  assert.deepEqual(stores.at(-1)?.db.listing('github:github.com:bia', 'acme/6'), [], "the save's adapter stores its items in the open model");
});

test('bootHive sweeps the prompt files a previous run left, in hive mode and in setup mode; hive mode keeps the directory', async (t) => {
  const stale = async (home: string): Promise<string> => {
    await mkdir(join(home, 'prompts'), { recursive: true });
    await writeFile(join(home, 'prompts', 'old.md'), 'last run');
    return join(home, 'prompts');
  };
  const { home } = await hiveWithConfig(t, {});
  const hivePrompts = await stale(home);
  const hive = await bootHive(home);
  t.after(() => hive.server.close());
  assert.deepEqual(await readdir(hivePrompts), []);

  const { home: setupHome } = await hiveWithConfig(t, WITH_SOURCE); // setup fallback
  const setupPrompts = await stale(setupHome);
  const setup = await bootHive(setupHome, { sourceFactory: unreadable });
  t.after(() => setup.server.close());
  await assert.rejects(readFile(join(setupPrompts, 'old.md')), { code: 'ENOENT' });
});

test('bootHive writes the boot to <home>/hive.log: mode=hive with a usable Comb, mode=setup with the reason when it is not', async (t) => {
  const { home } = await hiveWithConfig(t, {});
  const hive = await bootHive(home);
  t.after(() => hive.server.close());
  const lines = await logLines(home);
  assert.ok(lines.includes(`INFO  boot home=${home} workspaces=hive mode=hive`), lines.join('\n'));
  assert.ok(lines.includes(`INFO  listening port=${hive.port}`));
  assert.ok(!lines.some((l) => l.startsWith('INFO  poll source=')), 'a Comb with no source polls none');
  assert.ok(!lines.some((l) => l.startsWith('DEBUG')), 'default level is info');

  const broken = await hiveWithConfig(t, { ...WITH_SOURCE, logLevel: 'debug' });
  const setup = await bootHive(broken.home, { sourceFactory: unreadable }); // prints the source error on stderr too, as the spec wants for error
  t.after(() => setup.server.close());
  const setupLines = await logLines(broken.home);
  assert.ok(setupLines.some((l) => l.startsWith('ERROR source: ') && l.includes(UNREADABLE)), setupLines.join('\n'));
  assert.ok(setupLines.some((l) => l.startsWith(`INFO  boot home=${broken.home} mode=setup reason=`) && l.includes(UNREADABLE)));
});

test('bootHive logs a hive.config.json that cannot be parsed before rethrowing, so a broken boot leaves a trace', async (t) => {
  const home = await tempDir(t, 'boot-');
  await writeFile(join(home, 'hive.config.json'), '{ not json');
  await assert.rejects(bootHive(home), /JSON inválido/);
  const lines = await logLines(home);
  assert.ok(lines.some((l) => l.startsWith('ERROR config: ') && l.includes('JSON inválido')), lines.join('\n'));
});

test('a hive.config.json whose workspaces carry no name opens setup mode with the parse error and that folder proposed (#179)', async (t) => {
  const { home } = await hiveWithConfig(t, { workspaces: [{ path: '/elsewhere/app' }] });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "comb.workspaces[0].name" must be a letter or digit followed by up to 39 letters, digits, ".", "_" or "-"');
  assert.equal(info.proposedWorkspace, '/elsewhere/app', 'the form reopens with the folder it had');
});

test('a hive.config.json with comb.board opens setup mode with the parse error, nothing prefilled (#180)', async (t) => {
  const { home } = await hiveWithConfig(t, {});
  const raw = JSON.parse(await readFile(join(home, 'hive.config.json'), 'utf8')) as { comb: Record<string, unknown> };
  await writeFile(join(home, 'hive.config.json'), JSON.stringify({ ...raw, comb: { ...raw.comb, board: { type: 'github', owner: 'acme', number: 6 } } }));
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "comb.board" moved to "comb.sources"');
  assert.equal(info.config, undefined);
});

test('a hive.config.json whose source carries the workspace setting of #293 opens setup mode with the parse error, nothing prefilled (#688)', async (t) => {
  const { taskProps: _gone, ...bare } = GITHUB_ENTRY;
  const { home } = await hiveWithConfig(t, { sources: [{ ...bare, workspace: { mode: 'fixed', workspace: 'hive' } }], stages: STAGES });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "comb.sources[0].taskProps" must be an object like { "defaults": { "auto": true }, "rules": [] }');
  assert.equal(info.config, undefined);
});

test('a hive.config.json with none of onClose, menuBar and stopOnClose opens setup mode prefilled with onClose menuBar; a wrong onClose still fails the boot (#198, #513)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', onClose: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "onClose" must be one of: menuBar, quit');
  assert.deepEqual([info.config?.comb.prefix, info.config?.onClose], ['OLD', 'menuBar'], 'the rest of the file, the form default');
  assert.equal(info.proposedWorkspace, undefined, 'a prefilled form proposes nothing');
  assert.equal('onClose' in JSON.parse(await readFile(join(home, 'hive.config.json'), 'utf8')), false, 'nothing written until the user saves');

  const wrong = await hiveWithConfig(t, { onClose: 'yes' });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "onClose" must be one of: menuBar, quit' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json from before #513 (menuBar false, stopOnClose true) boots configured with onClose quit, and the file is untouched until a save (#513)', async (t) => {
  const { home } = await hiveWithConfig(t, { onClose: undefined, menuBar: false, stopOnClose: true });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, true);
  const onDisk = JSON.parse(await readFile(join(home, 'hive.config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(onDisk.menuBar, false, 'the file on disk is untouched: no boot writes it');
  assert.equal(onDisk.stopOnClose, true);
  assert.equal('onClose' in onDisk, false);
});

test('a hive.config.json without deleteActivity opens setup mode with the parse error, prefilled with the form\'s defaults; one still carrying delete activity fails the boot naming deleteActivity (#236, #573)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', deleteActivity: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "deleteActivity" must be an object with session, transcripts, nonAutoTasks');
  assert.deepEqual([info.config?.comb.prefix, info.config?.deleteActivity], ['OLD', DELETE_ACTIVITY_DEFAULTS], 'the rest of the file, the form defaults for the scope');
  const legacy = await hiveWithConfig(t, { cleanup: { worktree: true, branch: true, session: true, transcripts: false, nonAutoTasks: false } }); // #573: the old key, on purpose
  await assert.rejects(bootHive(legacy.home), { message: 'hive.config.json: "cleanup" is now "deleteActivity"' }, 'no legacy path: the one file is fixed by hand');
});

test('a hive.config.json without shutdownIdleMinutes opens setup mode with the parse error, prefilled with the form\'s 10 minutes; a value out of range still fails the boot (#233)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', shutdownIdleMinutes: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "shutdownIdleMinutes" must be an integer from 1 to 1440');
  assert.deepEqual([info.config?.comb.prefix, info.config?.shutdownIdleMinutes], ['OLD', SHUTDOWN_IDLE_DEFAULT], 'the rest of the file, the form default for the window');
  const wrong = await hiveWithConfig(t, { shutdownIdleMinutes: 0 });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "shutdownIdleMinutes" must be an integer from 1 to 1440' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without approvalMinutes opens setup mode with the parse error, prefilled with the form\'s 10 minutes; a value out of range still fails the boot (#268)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', approvalMinutes: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "approvalMinutes" must be an integer from 1 to 120');
  assert.deepEqual([info.config?.comb.prefix, info.config?.approvalMinutes], ['OLD', APPROVAL_MINUTES_DEFAULT], 'the rest of the file, the form default for the window');
  const wrong = await hiveWithConfig(t, { approvalMinutes: 121 });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "approvalMinutes" must be an integer from 1 to 120' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without rateLimitWaitMinutes opens setup mode with the parse error, prefilled with the form\'s 300 minutes; a value out of range still fails the boot (#805)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', rateLimitWaitMinutes: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "rateLimitWaitMinutes" must be an integer from 1 to 10080');
  assert.deepEqual([info.config?.comb.prefix, info.config?.rateLimitWaitMinutes], ['OLD', RATE_LIMIT_WAIT_DEFAULT], 'the rest of the file, the form default for the wait');
  const wrong = await hiveWithConfig(t, { rateLimitWaitMinutes: 10_081 });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "rateLimitWaitMinutes" must be an integer from 1 to 10080' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without sidebarsPerView opens setup mode with the parse error, prefilled with the defaults; a field that is not a boolean still fails the boot (#821)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', sidebarsPerView: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "sidebarsPerView" must be an object with left, right, rightTab');
  assert.deepEqual([info.config?.comb.prefix, info.config?.sidebarsPerView], ['OLD', SIDEBARS_PER_VIEW_DEFAULTS], 'the rest of the file, the form default');
  const wrong = await hiveWithConfig(t, { sidebarsPerView: { left: true, right: 'yes', rightTab: true } });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "sidebarsPerView.right" must be true or false' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without notifications opens setup mode with the parse error, prefilled with every kind on; a field that is not a boolean still fails the boot (#199)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', notifications: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "notifications" must be an object with waiting, approval, pr, failed');
  assert.deepEqual([info.config?.comb.prefix, info.config?.notifications], ['OLD', VIEWER_DEFAULTS.notifications], 'the rest of the file, the form default');
  const wrong = await hiveWithConfig(t, { notifications: { waiting: true, approval: 'yes', pr: true, failed: true } });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "notifications.approval" must be true or false' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without signals opens setup mode with the parse error, prefilled with the defaults; a field that is wrong still fails the boot (#727)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', signals: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "signals" must be an object with green, yellow, red, onOpen');
  assert.deepEqual([info.config?.comb.prefix, info.config?.signals], ['OLD', SIGNALS_DEFAULTS], 'the rest of the file, the form default');
  const wrong = await hiveWithConfig(t, { signals: { ...SIGNALS_DEFAULTS, onOpen: 'blue' } });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "signals.onOpen" must be one of: yellow, last, green' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without the four close-tab keys opens setup mode with the parse error, prefilled with keep, keep and both notices on; the old keys are dropped, and a value that is there but wrong still fails the boot (#614)', async (t) => {
  const { home } = await hiveWithConfig(t, {
    prefix: 'OLD', closeSessionTab: undefined, closeStageTab: undefined, closeSessionTabNotice: undefined, closeStageTabNotice: undefined,
    closeTabEndsSession: true, closeTabEndsStageSession: false,
  });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "closeSessionTab" must be one of: keep, sleep');
  const config = info.config;
  assert.deepEqual([config?.comb.prefix, config?.closeSessionTab, config?.closeStageTab, config?.closeSessionTabNotice, config?.closeStageTabNotice], ['OLD', 'keep', 'keep', true, true], 'the rest of the file, the form defaults');
  assert.equal(config !== undefined && 'closeTabEndsSession' in config, false, 'an old key is never read');
  const wrong = await hiveWithConfig(t, { closeStageTab: 'pause' });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "closeStageTab" must be one of: keep, sleep' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without theme opens setup mode with the parse error, prefilled with system; an unknown theme still fails the boot (#296)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', theme: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "theme" must be one of: system, light, dark');
  assert.deepEqual([info.config?.comb.prefix, info.config?.theme], ['OLD', 'system'], 'the rest of the file, the form default for the theme');
  const wrong = await hiveWithConfig(t, { theme: 'sepia' });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "theme" must be one of: system, light, dark' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without terminalFont opens setup mode with the parse error, prefilled with ""; a name with a quote still fails the boot (#376)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', terminalFont: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "terminalFont" must be a string ("" = the system monospace)');
  assert.deepEqual([info.config?.comb.prefix, info.config?.terminalFont], ['OLD', ''], 'the rest of the file, the form default for the font');
  const wrong = await hiveWithConfig(t, { terminalFont: 'Meslo"NF' });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "terminalFont" must be one font family name, without ", \\ or control characters' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without consoleLines opens setup mode with the parse error, prefilled with 5000; a value out of range still fails the boot (#353)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', consoleLines: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  const error = 'hive.config.json: "consoleLines" must be an integer from 100 to 100000';
  assert.equal(info.configured, false);
  assert.equal(info.error, error);
  assert.deepEqual([info.config?.comb.prefix, info.config?.consoleLines], ['OLD', 5000], 'the rest of the file, the form default for the lines');
  const wrong = await hiveWithConfig(t, { consoleLines: 50 });
  await assert.rejects(bootHive(wrong.home), { message: error }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without trustedDomains opens setup mode with the parse error, prefilled with []; an entry that is not a host still fails the boot (#404)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', trustedDomains: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "trustedDomains" must be an array of host names ([] = every link asks)');
  assert.deepEqual([info.config?.comb.prefix, info.config?.trustedDomains], ['OLD', []], 'the rest of the file, the form default for the list');
  const wrong = await hiveWithConfig(t, { trustedDomains: ['https://github.com'] });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "trustedDomains" holds "https://github.com", which is not a host name (like github.com: no scheme, port, path or *)' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json without shortcuts opens setup mode with the parse error, prefilled with {}; a binding that is not one still fails the boot (#449)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', shortcuts: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "shortcuts" must be an object of shortcut ids to a key binding or null ({} = every default)');
  assert.deepEqual([info.config?.comb.prefix, info.config?.shortcuts], ['OLD', {}], 'the rest of the file, every default for the shortcuts');
  const wrong = await hiveWithConfig(t, { shortcuts: { toggleRight: 'J' } });
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "shortcuts.toggleRight" must be null (off) or a key binding like CmdOrCtrl+Shift+J; a letter, digit or punctuation key needs CmdOrCtrl, Ctrl or Alt' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json whose Comb has no commands (and whose workspaces have none either) opens setup mode with the parse error, prefilled with none; commands that are there but wrong still fail the boot (#300, #511)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD' });
  await rewriteComb(home, ({ commands: _commands, ...comb }) => comb);
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "comb.commands" must be an array');
  assert.deepEqual([info.config?.comb.prefix, info.config?.comb.commands], ['OLD', []], 'the rest of the file, no command');
  const wrong = await hiveWithConfig(t, {});
  await rewriteComb(wrong.home, (comb) => ({ ...comb, commands: 'x' }));
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "comb.commands" must be an array' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json whose workspaces have no env opens setup mode with the parse error, prefilled with an empty one; an env that is there but wrong still fails the boot (#348)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD' });
  await rewriteWorkspaces(home, ({ env: _env, ...workspace }) => workspace);
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "comb.workspaces[0].env" must be an object of strings');
  assert.deepEqual([info.config?.comb.prefix, info.config?.comb.workspaces[0].env], ['OLD', {}], 'the rest of the file, an empty env');
  const wrong = await hiveWithConfig(t, {});
  await rewriteWorkspaces(wrong.home, (workspace) => ({ ...workspace, env: 'x' }));
  await assert.rejects(bootHive(wrong.home), { message: 'hive.config.json: "comb.workspaces[0].env" must be an object of strings' }, 'a key that is there but wrong is no file from before the key');
});

test('a hive.config.json whose workspace keeps format, or without editor, fails the boot naming the key: no prefill, the one file is fixed by hand (#780)', async (t) => {
  const kept = await hiveWithConfig(t, {});
  await rewriteWorkspaces(kept.home, (workspace) => ({ ...workspace, format: { onSave: true, formatters: {}, custom: [] } }));
  await assert.rejects(bootHive(kept.home), { message: /^hive\.config\.json: "comb\.workspaces\[0\]\.format" moved to "editor"/ });
  const none = await hiveWithConfig(t, { editor: undefined });
  await assert.rejects(bootHive(none.home), { message: /^hive\.config\.json: editor is required/ });
});

test('a hive.config.json from before #516 boots with defaultAgent claude; the agents found on boot reach GET /settings (#516)', async (t) => {
  const agents: AgentAvailability[] = [{ agent: 'claude', available: false }];
  const { home } = await hiveWithConfig(t, { defaultAgent: undefined });
  const { server, port } = await bootHive(home, { agents });
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.deepEqual([info.configured, info.config?.defaultAgent, info.agents], [true, 'claude', agents]);
});

test('a hive.config.json that still holds ide boots in hive mode, the key ignored; GET /settings names no IDE (#818)', async (t) => {
  const { home } = await hiveWithConfig(t, { ide: 'zed' });
  const { server, port } = await bootHive(home, { agents: [{ agent: 'claude', available: true }] });
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, true);
  assert.deepEqual(['ide' in (info.config ?? {}), 'ides' in info], [false, false]);
});

test('bootHive turns the locale into the system language: pt-BR without a config language gives pt, the config wins when set, and setup mode carries it too', async (t) => {
  const ptHome = (await hiveWithConfig(t, {})).home;
  const pt = await bootHive(ptHome, { locale: 'pt-BR' });
  t.after(() => pt.server.close());
  assert.equal((await settingsInfo(ptHome, pt.port)).language, 'pt');
  const enHome = (await hiveWithConfig(t, { language: 'en' })).home;
  const en = await bootHive(enHome, { locale: 'pt-BR' });
  t.after(() => en.server.close());
  assert.equal((await settingsInfo(enHome, en.port)).language, 'en', 'the config wins over the system');
  const broken = await hiveWithConfig(t, WITH_SOURCE); // setup fallback
  const setup = await bootHive(broken.home, { locale: 'en-US', sourceFactory: unreadable });
  t.after(() => setup.server.close());
  assert.equal((await settingsInfo(broken.home, setup.port)).language, 'en');
});

test('bootHive with a hive.config.json from before the Comb opens setup mode with the reason and an empty form', async (t) => {
  const home = await tempDir(t, 'boot-');
  await writeFile(join(home, 'hive.config.json'), JSON.stringify({ auth: AUTH, board: { type: 'github', owner: 'acme', number: 6 }, columns: STAGES }));
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "board" moved to "comb.board"');
  assert.equal(info.config, undefined, 'nothing proposed: the form opens empty');
  assert.ok((await logLines(home)).some((l) => l.startsWith('INFO  boot home=') && l.includes('mode=setup') && l.includes('moved to "comb.board"')));
});

test('bootHive keeps its own files in the home: the repo gets only the exclude line, and a hive.config.json or .hive/ left in the repo is neither read nor deleted', async (t) => {
  const { home, repo } = await hiveWithConfig(t, {});
  const leftover = JSON.stringify(combConfig({ prefix: 'OLD', path: repo }));
  await writeFile(join(repo, 'hive.config.json'), leftover);
  await mkdir(join(repo, '.hive'));
  await saveState(join(repo, '.hive'), { ...initialState(0), signal: 'red' });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  assert.equal((await settingsInfo(home, port)).config?.comb.prefix, 'HIVE', 'the home\'s config, not the repo\'s');
  assert.equal(server.getState()?.signal, 'yellow', 'the repo\'s state.json (red) was not read');
  // WAL keeps a -wal and a -shm beside each database while it is open (#180, #271): its side files, not files of their own
  const own = (await readdir(home)).filter((name) => !/^(read-model|usage)\.sqlite-(wal|shm)$/.test(name)).sort();
  assert.deepEqual(own, ['bin', 'events.jsonl', 'hive.config.json', 'hive.lock', 'hive.log', 'hive.port', 'hive.secret', 'hooks.json', 'lsp', 'plugins', 'prompts', 'protocol', 'read-model.sqlite', 'shell', 'state.json', 'usage.sqlite']);
  assert.deepEqual((await readdir(repo)).sort(), ['.git', '.hive', 'hive.config.json']);
  assert.deepEqual(await readdir(join(repo, '.hive')), ['state.json'], 'nothing new under the repo\'s .hive/: no log, no hooks, no prompts');
  assert.equal(await readFile(join(repo, 'hive.config.json'), 'utf8'), leftover, 'never rewritten, never deleted');
  assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.hive\/$/m, 'the worktrees still live in <repo>/.hive/');
});

test('with nothing saved, setup mode proposes the folder the Hive started in when it is a git repo\'s top level, and nothing from a subfolder or a plain folder', async (t) => {
  const launchedIn = process.cwd();
  t.after(() => process.chdir(launchedIn));
  // An empty home: nothing to prefill, and a free port of its own (#466)
  const unconfigured = async (): Promise<SettingsInfo> => {
    const home = await tempDir(t, 'home-');
    const { server, port } = await bootHive(home);
    t.after(() => server.close());
    return settingsInfo(home, port);
  };
  const { repo } = await tempHive(t);
  process.chdir(repo);
  assert.equal((await unconfigured()).proposedWorkspace, await realpath(repo), 'process.cwd() is already the real path');
  await mkdir(join(repo, 'src'));
  process.chdir(join(repo, 'src'));
  assert.equal((await unconfigured()).proposedWorkspace, undefined, 'inside a repo is not its top level');
  process.chdir(await tempDir(t, 'plain-'));
  assert.equal((await unconfigured()).proposedWorkspace, undefined, 'a Dock launch (cwd /) lands here too');
});

test('bootHive reads the plan limits through the injected reader on boot, so the header has them before any worker; no reader, no reading', async (t) => {
  const { home } = await hiveWithConfig(t, {});
  const rateLimits: RateLimits = { at: '2026-09-17T12:00:00.000Z', windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-17T15:00:00.000Z' } } };
  let reads = 0;
  const { server } = await bootHive(home, { readPlanLimits: async () => { reads += 1; return claudePlan(rateLimits); } });
  t.after(() => server.close());
  assert.equal(reads, 1);
  assert.deepEqual(server.getState()?.rateLimits?.claude, rateLimits);
  const plain = (await hiveWithConfig(t, {})).home;
  const bare = await bootHive(plain);
  t.after(() => bare.server.close());
  assert.equal(bare.server.getState()?.rateLimits, undefined);
  assert.ok(!(await logLines(plain)).some((l) => l.includes('plan limits')), 'nothing to say without a reader');
});

test('bootHive forwards onStop in hive mode and in setup mode: POST /stop on the booted server calls it', async (t) => {
  let stops = 0;
  const onStop = (): void => { stops += 1; };
  const stopHome = (await hiveWithConfig(t, {})).home;
  const hive = await bootHive(stopHome, { onStop });
  t.after(() => hive.server.close());
  assert.deepEqual(await (await postStop(stopHome, hive.port)).json(), { ok: true });
  for (let i = 0; i < 50 && stops < 1; i += 1) await sleep(5); // setImmediate on the server side
  assert.equal(stops, 1);

  const broken = await hiveWithConfig(t, WITH_SOURCE); // setup fallback: a daemon in setup mode must stop too
  const setup = await bootHive(broken.home, { onStop, sourceFactory: unreadable });
  t.after(() => setup.server.close());
  assert.equal((await postStop(broken.home, setup.port)).status, 200);
  for (let i = 0; i < 50 && stops < 2; i += 1) await sleep(5);
  assert.equal(stops, 2);
});

test('a hive.config.json that still holds terminal boots in hive mode, and no boot line names a terminal mode (#378)', async (t) => {
  const { home } = await hiveWithConfig(t, { terminal: 'internal' });
  const booted = await bootHive(home);
  t.after(() => booted.server.close());
  assert.equal((await settingsInfo(home, booted.port)).configured, true);
  const lines = await logLines(home);
  assert.ok(!lines.some((l) => l.includes('terminal')), lines.join('\n'));
});

test('a hive.config.json without the four sleep notice keys opens setup mode with the parse error, prefilled with all four on (#672)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', sleepNotice: undefined, sleepAutoNotice: undefined, sleepIdleNotice: undefined, sleepAllNotice: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "sleepNotice" must be true or false');
  const config = info.config;
  assert.deepEqual([config?.comb.prefix, config?.sleepNotice, config?.sleepAutoNotice, config?.sleepIdleNotice, config?.sleepAllNotice], ['OLD', true, true, true, true]);
});

test('both modes open the read model in the home: setup mode keeps it for the save that leaves it (#180, #401)', async (t) => {
  const { home } = await hiveWithConfig(t, {});
  const hive = await bootHive(home);
  t.after(() => hive.server.close());
  assert.equal(existsSync(join(home, READ_MODEL_FILE)), true);
  const empty = await tempDir(t, 'home-');
  const setup = await bootHive(empty);
  t.after(() => setup.server.close());
  assert.equal(existsSync(join(empty, READ_MODEL_FILE)), true);
});

test('bootHive opens usage.sqlite in the home in hive mode and in setup mode, since a setup saved in place runs workers too (#271)', async (t) => {
  const { home } = await hiveWithConfig(t, {});
  const hive = await bootHive(home);
  t.after(() => hive.server.close());
  const empty = await tempDir(t, 'home-');
  const setup = await bootHive(empty);
  t.after(() => setup.server.close());
  assert.deepEqual([existsSync(join(home, USAGE_FILE)), existsSync(join(empty, USAGE_FILE))], [true, true]);
});

test('a read model that cannot be opened is logged, and the daemon boots without its sync (#180)', async (t) => {
  const { home } = await hiveWithConfig(t, {});
  await mkdir(join(home, READ_MODEL_FILE)); // a directory: no database opens there, and the rebuild cannot delete it
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  assert.equal((await settingsInfo(home, port)).configured, true);
  assert.ok((await logLines(home)).some((line) => line.includes('read model: not opened')));
});

test('bootHive hydrates the loaded tasks from every source\'s stored() before the first rule; a stored() that rejects leaves its tasks lean and the boot goes on (#191)', async (t) => {
  const lean: Task = { item: { itemId: 'board:I1', id: '1', title: '', body: '', url: '', source: 'board' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  const kept: SourceItem = { item: { itemId: 'I1', id: '1', title: 'from the model', body: 'b', url: 'https://github.com/acme/r/issues/1' }, column: 'Ready' };
  // The poll fails, so what the state holds after the boot is what the boot read gave back
  const offline = (stored: () => Promise<SourceItem[]>) => (spec: SourceSpec): Source =>
    ({ ...fakeSourceFactory().factory(spec), listItems: () => Promise.reject(new Error('no network')), stored });

  const { home } = await hiveWithConfig(t, WITH_SOURCE);
  await saveState(home, { ...initialState(0), tasks: [lean] });
  const hive = await bootHive(home, { sourceFactory: offline(async () => [kept]) });
  t.after(() => hive.server.close());
  assert.deepEqual(hive.server.getState()?.tasks.map((task) => [task.item.itemId, task.item.title, task.item.source]), [['board:I1', 'from the model', 'board']]);

  const failing = await hiveWithConfig(t, WITH_SOURCE);
  await saveState(failing.home, { ...initialState(0), tasks: [lean] });
  const booted = await bootHive(failing.home, { sourceFactory: offline(() => Promise.reject(new Error('model gone'))) });
  t.after(() => booted.server.close());
  assert.deepEqual(booted.server.getState()?.tasks.map((task) => task.item.title), ['']);
  assert.ok((await logLines(failing.home)).some((l) => l.includes('source board: the read model\'s listing was not read at boot: model gone')));
});

test('a source offline at boot boots hive mode: its tasks come from the read model, its poll error says why, and the poll once the network is back resolves it once and lists (#291)', async (t) => {
  const OFFLINE = 'gh api graphql: error connecting to api.github.com';
  const lean: Task = { item: { itemId: 'board:I1', id: '1', title: '', body: '', url: '', source: 'board' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  const facets = { assignees: ['bia'], labels: ['hive'], fields: { Priority: 'P1' } };
  const kept: SourceItem = { item: { itemId: 'I1', id: '1', title: 'from the model', body: 'b', url: 'https://github.com/acme/r/issues/1', facets }, column: 'Ready' };
  let isOnline = false;
  const resolves: boolean[] = []; // whether the network was up at each resolveFields call
  const offlineAtBoot = (spec: SourceSpec): Source => {
    const fake = fakeSourceFactory().factory(spec);
    return {
      ...fake,
      resolveFields: () => {
        resolves.push(isOnline);
        return isOnline ? fake.resolveFields() : Promise.reject(new Error(OFFLINE));
      },
      stored: async () => [kept],
    };
  };
  const { home } = await hiveWithConfig(t, WITH_SOURCE);
  await saveState(home, { ...initialState(0), tasks: [lean] });
  const hive = await bootHive(home, { sourceFactory: offlineAtBoot });
  t.after(() => hive.server.close());
  const booted = hive.server.getState();
  assert.ok(booted !== undefined, 'hive mode, not setup');
  assert.deepEqual(booted.tasks.map((task) => [task.item.title, task.item.body, task.item.facets]), [['from the model', 'b', facets]]);
  assert.equal(booted.syncs.board?.error, OFFLINE, 'the boot poll retried the resolve and failed on the network');
  assert.deepEqual(resolves, [false, false], 'the boot resolve, then the boot poll\'s');

  isOnline = true;
  await hive.server.poll();
  const polled = hive.server.getState();
  assert.equal(polled?.syncs.board?.error, undefined);
  assert.deepEqual(polled?.tasks.map((task) => task.item.title), ['from Ready'], 'the poll listed');
  await hive.server.poll();
  assert.deepEqual(resolves, [false, false, true], 'resolved once: the next poll only lists');
  const lines = await logLines(home);
  assert.ok(lines.some((l) => l === `WARN  source board: offline at boot, resolved on a later poll (${OFFLINE})`), lines.join('\n'));
  assert.ok(lines.some((l) => l === 'INFO  source board: resolved on a later poll'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('mode=setup')));
});

test('a hive.config.json without mcp opens setup mode with the parse error, prefilled with no tool off and no server; a locked tool in off still fails the boot (#333)', async (t) => {
  const { home } = await hiveWithConfig(t, { prefix: 'OLD', mcp: undefined });
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const info = await settingsInfo(home, port);
  assert.equal(info.configured, false);
  assert.equal(info.error, 'hive.config.json: "mcp" must be an object with off and servers');
  assert.deepEqual([info.config?.comb.prefix, info.config?.mcp], ['OLD', MCP_DEFAULTS], 'the rest of the file, the defaults');
  const wrong = await hiveWithConfig(t, { mcp: { off: ['hive_done'], servers: [] } });
  await assert.rejects(bootHive(wrong.home), { message: /^hive\.config\.json: "mcp\.off" holds hive_done/ }, 'a key that is there but wrong is no file from before the key');
});
