import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempDir, type AfterHost } from './temp-dir.js';

const execFileAsync = promisify(execFile);
const HIVE_BIN = fileURLToPath(new URL('../../bin/hive.js', import.meta.url));
const PORT = 4242;
const PID = 77;

// this machine may export a global NODE_PATH pointing at the real workspace's node_modules; strip it so a
// tree that deliberately has no node_modules/electron is not silently rescued by that legacy fallback
const envWithoutNodePath: NodeJS.ProcessEnv = { ...process.env };
delete envWithoutNodePath.NODE_PATH;

// ESM fake dist/src/login.js: prints what it was given and exits with the code in HIVE_FAKE_LOGIN_CODE.
const FAKE_LOGIN_JS = `
export async function runLogin(provider) {
  console.log('login ' + provider);
  return Number(process.env.HIVE_FAKE_LOGIN_CODE ?? 0);
}
`;

type Answer = boolean | { port: number; pid?: number } | { error: string };
const DEFAULT_ANSWERS: Record<string, Answer> = { ensureDaemon: { port: PORT, pid: PID }, stopDaemon: true };

interface Run { code: number; stdout: string; stderr: string }

/** Runs bin/hive.js from `root` with `args`; resolves with the exit code and both streams whether it exited 0 or not. */
async function hive(root: string, args: string[], env: NodeJS.ProcessEnv = envWithoutNodePath): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const { code, stdout, stderr } = err as { code?: number; stdout?: string; stderr?: string };
    return { code: code ?? -1, stdout: stdout ?? '', stderr: stderr ?? '' };
  }
}

const HOME_JS = fileURLToPath(new URL('../src/home.js', import.meta.url)); // the real build's: the script resolves the home through it

// ESM fake main.js: logs its arguments (none: the viewer names no repo), waits for <home>/go, then records the PATH it saw in the home.
// Gating on a file the test writes, not on a sleep, keeps the ordering assertions independent of host load (#552).
const FAKE_MAIN_JS = `
import { existsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const home = join(process.env.XDG_CONFIG_HOME, 'agent-hive');
console.log('fake main up, args: ' + JSON.stringify(process.argv.slice(2)));
const poll = setInterval(() => {
  if (!existsSync(join(home, 'go'))) return;
  clearInterval(poll);
  // Written beside and renamed in: a test that polls for the marker must never read it half written
  writeFile(join(home, 'marker.tmp'), process.env.PATH ?? '').then(() => rename(join(home, 'marker.tmp'), join(home, 'marker')));
}, 50);
setTimeout(() => process.exit(0), 60_000).unref(); // a test that failed before writing go must not leave this viewer polling forever
`;

// ESM fake dist/src/daemon.js: appends "<function> <home>" to <home>/daemon-calls and answers from <home>/daemon-answer.json,
// where each function's entry is its return value, or { error } to throw. The script alone is under test.
const FAKE_DAEMON_JS = `
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function answer(name, home) {
  appendFileSync(join(home, 'daemon-calls'), name + ' ' + home + '\\n');
  const value = JSON.parse(readFileSync(join(home, 'daemon-answer.json'), 'utf8'))[name];
  if (value && typeof value === 'object' && 'error' in value) throw new Error(value.error);
  return value;
}
export const ensureDaemon = async (home) => answer('ensureDaemon', home);
export const stopDaemon = async (home) => answer('stopDaemon', home);
`;

/** A package tree with the script and a fake dist (main.js + daemon.js + login.js, the real home.js); `withElectron` adds a fake electron package resolving to node. */
async function setupRoot(t: AfterHost, withElectron: boolean): Promise<string> {
  const root = await tempDir(t, 'cli-');
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, 'dist', 'src', 'main.js'), FAKE_MAIN_JS);
  await writeFile(join(root, 'dist', 'src', 'daemon.js'), FAKE_DAEMON_JS);
  await writeFile(join(root, 'dist', 'src', 'login.js'), FAKE_LOGIN_JS);
  await copyFile(HOME_JS, join(root, 'dist', 'src', 'home.js'));
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  if (withElectron) {
    // require('electron') resolves to the node binary; the "Electron" child is node running fake main.js
    await mkdir(join(root, 'node_modules', 'electron'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'electron', 'package.json'), '{ "type": "commonjs", "main": "index.js" }\n');
    await writeFile(join(root, 'node_modules', 'electron', 'index.js'), 'module.exports = process.execPath;\n');
  }
  return root;
}

/** A home under its own XDG_CONFIG_HOME whose fake daemon answers `answers` (the defaults: port 4242, a fresh start with pid 77, a stop
 * that stopped); `env` runs the script against it, never against the real ~/.config. The home starts with `go`, so a viewer writes its
 * marker as soon as it runs; a test that asserts ordering removes it first. */
async function homeAnswering(t: AfterHost, answers: Partial<Record<string, Answer>> = {}): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const xdg = await tempDir(t, 'xdg-');
  const home = join(xdg, 'agent-hive');
  await mkdir(home);
  await writeFile(join(home, 'daemon-answer.json'), JSON.stringify({ ...DEFAULT_ANSWERS, ...answers }));
  await writeFile(join(home, 'go'), '');
  // HIVE_HOME wins over XDG_CONFIG_HOME: one inherited from the shell would point the script at a real home
  const { HIVE_HOME: _home, ...rest } = envWithoutNodePath;
  return { home, env: { ...rest, XDG_CONFIG_HOME: xdg } };
}

const calls = async (home: string): Promise<string[]> => (await readFile(join(home, 'daemon-calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

// no deadline of its own: under a loaded gate the viewer can take seconds, so the test's own timeout is the only bound
const VIEWER_TEST = { timeout: 30_000 };

/** Polls for the viewer's marker until it exists or the test's `signal` aborts, so a timed-out test stops polling instead of hanging the run. */
async function waitForMarker(home: string, signal: AbortSignal): Promise<void> {
  while (!existsSync(join(home, 'marker'))) await delay(50, undefined, { signal });
}

test('hive exits 2 with a build hint when dist/src/daemon.js is missing, before touching electron', async (t) => {
  const root = await tempDir(t, 'cli-');
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  const run = await hive(root, []);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /pnpm build/);
  const stop = await hive(root, ['stop']);
  assert.equal(stop.code, 2);
});

test('hive takes no folder: any other first argument, or anything after stop, is a usage error (exit 2) that asks the daemon nothing', async (t) => {
  const root = await setupRoot(t, true);
  const { home, env } = await homeAnswering(t);
  for (const args of [['some/path'], ['.'], ['stop', 'some/path']]) {
    const run = await hive(root, args, env);
    assert.equal(run.code, 2, args.join(' '));
    assert.match(run.stderr, /uso: hive \| hive stop \| hive login \[provider\]/);
  }
  assert.deepEqual(await calls(home), [], 'no daemon asked');
  await delay(400);
  assert.equal(existsSync(join(home, 'marker')), false, 'no window either');
});

test('hive exits 1 with an install hint when electron is not installed, before starting anything; hive stop never needs electron', async (t) => {
  const root = await setupRoot(t, false);
  const { home, env } = await homeAnswering(t);
  const run = await hive(root, [], env);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /pnpm install/);
  assert.deepEqual(await calls(home), [], 'no daemon started for a viewer that cannot open');
  const stop = await hive(root, ['stop'], env);
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /Agent Hive parado/);
  assert.deepEqual(await calls(home), [`stopDaemon ${home}`]);
});

test('hive starts the daemon of the home, prints the started line with the pid and the home log, spawns the viewer detached with no repo, and returns before it ends', VIEWER_TEST, async (t) => {
  const root = await setupRoot(t, true);
  const { home, env } = await homeAnswering(t);
  await rm(join(home, 'go')); // the viewer holds its marker until the test says so: a parent that waited for it would never return
  const run = await hive(root, [], { ...env, PATH: `${process.env.PATH}:/hive-test-marker` });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), `Agent Hive iniciado em http://127.0.0.1:${PORT} (pid ${PID}, log: ${join(home, 'hive.log')})`);
  assert.deepEqual(await calls(home), [`ensureDaemon ${home}`]);
  assert.equal(existsSync(join(home, 'marker')), false);
  await writeFile(join(home, 'go'), '');
  await waitForMarker(home, t.signal);
  assert.match(await readFile(join(home, 'marker'), 'utf8'), /\/hive-test-marker/); // inherited PATH reached the detached viewer
  assert.match(await readFile(join(home, 'hive.log'), 'utf8'), /fake main up, args: \[\]/, 'the viewer\'s stdout went to the home log, and it got no repo');
});

test('hive with the daemon already up prints the already-running line without a pid and still opens the viewer', VIEWER_TEST, async (t) => {
  const root = await setupRoot(t, true);
  const { home, env } = await homeAnswering(t, { ensureDaemon: { port: PORT } });
  const run = await hive(root, [], env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), `Agent Hive já está em execução em http://127.0.0.1:${PORT}, abrindo a janela`);
  await waitForMarker(home, t.signal); // the window opens either way
});

test('hive stop calls stopDaemon with the home and prints stopped or not running; exit 0 either way; nothing is spawned', async (t) => {
  const root = await setupRoot(t, true);
  const stopped = await homeAnswering(t);
  const run = await hive(root, ['stop'], stopped.env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'Agent Hive parado');
  assert.deepEqual(await calls(stopped.home), [`stopDaemon ${stopped.home}`]);
  const idle = await homeAnswering(t, { stopDaemon: false });
  const notRunning = await hive(root, ['stop'], idle.env);
  assert.equal(notRunning.stdout.trim(), 'Agent Hive não está em execução');
  assert.deepEqual(await calls(idle.home), [`stopDaemon ${idle.home}`]);
  await delay(400);
  assert.equal(existsSync(join(stopped.home, 'marker')), false);
  assert.equal(existsSync(join(idle.home, 'marker')), false);
});

test('a daemon that refuses or fails to start ends hive with its message and exit 1, and a stop that fails the same way', async (t) => {
  const root = await setupRoot(t, true);
  const refused = await homeAnswering(t, { ensureDaemon: { error: 'Agent Hive não subiu (veja /x/hive.log)' } });
  const run = await hive(root, [], refused.env);
  assert.equal(run.code, 1);
  assert.equal(run.stderr.trim(), 'Agent Hive não subiu (veja /x/hive.log)');
  await delay(400);
  assert.equal(existsSync(join(refused.home, 'marker')), false, 'no window without a Hive');
  const stuck = await homeAnswering(t, { stopDaemon: { error: 'Agent Hive não parou em 30 s (pid no log)' } });
  const stop = await hive(root, ['stop'], stuck.env);
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /não parou em 30 s/);
});

test('hive login runs the login module with the provider (github by default) and exits with its code, without touching a repo or electron', async (t) => {
  const root = await setupRoot(t, false); // no electron: the login never opens a window
  const bare = await hive(root, ['login']);
  assert.equal(bare.code, 0, bare.stderr);
  assert.equal(bare.stdout.trim(), 'login undefined');
  const named = await hive(root, ['login', 'github']);
  assert.equal(named.stdout.trim(), 'login github');
  const failing = await hive(root, ['login'], { ...envWithoutNodePath, HIVE_FAKE_LOGIN_CODE: '1' });
  assert.equal(failing.code, 1);
  const noBuild = await tempDir(t, 'cli-');
  await mkdir(join(noBuild, 'bin'));
  await writeFile(join(noBuild, 'package.json'), '{ "type": "module" }\n');
  await copyFile(HIVE_BIN, join(noBuild, 'bin', 'hive.js'));
  const unbuilt = await hive(noBuild, ['login']);
  assert.equal(unbuilt.code, 2);
  assert.match(unbuilt.stderr, /pnpm build/);
});
