import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureChromium, keepShots, mcpBinary, mcpConfig, type SampleChild, startSample, stopSample, waitReady } from '../../src/benchmark/browser.js';
import { tempDir } from '../temp-dir.js';

test("mcpConfig runs the Playwright MCP's bin with this Node, headless and isolated on the sample's origin, its shots in the output dir; no storage state unless given (#105, #474)", () => {
  const server = mcpConfig({ bin: '/pkg/mcp/cli.js', outputDir: '/review/screens', origin: 'http://127.0.0.1:5173', chromiumPath: '/pw/chromium/chrome', socketsDir: '/tmp/hive-pw-x1' }).mcpServers.playwright;
  assert.equal(server.command, process.execPath);
  assert.equal(server.args[0], '/pkg/mcp/cli.js');
  // macOS caps a socket path at 104 bytes; Electron's execPath runs the bin as plain Node only with ELECTRON_RUN_AS_NODE
  assert.deepEqual(server.env, { PWTEST_SOCKETS_DIR: '/tmp/hive-pw-x1', ELECTRON_RUN_AS_NODE: '1' });
  for (const arg of ['--headless', '--isolated', '--output-dir', '/review/screens', '1440,900', '--allowed-origins', 'http://127.0.0.1:5173', '--executable-path', '/pw/chromium/chrome']) assert.ok(server.args.includes(arg), arg);
  assert.equal(server.args.includes('--storage-state'), false);
  const stored = mcpConfig({ bin: 'b', outputDir: 'o', origin: 'x', chromiumPath: 'c', socketsDir: 's', storage: '/review/state.json' }).mcpServers.playwright.args;
  assert.deepEqual(stored.slice(stored.indexOf('--storage-state'), stored.indexOf('--storage-state') + 2), ['--storage-state', '/review/state.json']);
});

test("mcpBinary is @playwright/mcp's own bin file, found through its package.json, not node_modules/.bin (#474)", async () => {
  const bin = await mcpBinary();
  assert.ok(bin.endsWith(join('@playwright', 'mcp', 'cli.js')), bin);
  assert.ok(existsSync(bin));
});

test('ensureChromium answers the installed Chromium, installs it once when missing, and answers the reason when the install fails (#474)', async () => {
  let installs = 0;
  const path = async (): Promise<string> => '/pw/chrome';
  assert.deepEqual(await ensureChromium({ executablePath: path, exists: () => true, install: async () => { installs += 1; } }), { path: '/pw/chrome' });
  assert.equal(installs, 0);
  let installed = false;
  assert.deepEqual(await ensureChromium({ executablePath: path, exists: () => installed, install: async () => { installs += 1; installed = true; } }), { path: '/pw/chrome' });
  assert.equal(installs, 1);
  assert.deepEqual(await ensureChromium({ executablePath: path, exists: () => false, install: async () => { throw new Error('no network\nmore'); } }), { reason: 'Chromium is not installed: no network' });
  assert.deepEqual(await ensureChromium({ executablePath: path, exists: () => false, install: async () => undefined }), { reason: 'Chromium is not installed: the install left no browser' });
});

test('keepShots copies every PNG under the folder, a nested one named by its path, with the prefix, and answers the kept names (#105, #474)', async (t) => {
  const dir = await tempDir(t, 'shots-');
  await mkdir(join(dir, 'from', 'screens'), { recursive: true });
  await writeFile(join(dir, 'from', 'S1-1.png'), 'png');
  await writeFile(join(dir, 'from', 'screens', 'page.png'), 'png');
  await writeFile(join(dir, 'from', 'mcp.json'), '{}');
  assert.deepEqual(await keepShots(join(dir, 'from'), join(dir, 'to'), '2-'), ['2-S1-1.png', '2-screens-page.png']);
  assert.deepEqual((await readdir(join(dir, 'to'))).sort(), ['2-S1-1.png', '2-screens-page.png']);
});

type FakeChild = SampleChild & { exitCode: number | null; exit(): void };
function fakeChild(pid = 4242): FakeChild {
  const events = new EventEmitter();
  const child: FakeChild = { pid, exitCode: null, once: (event, listener) => events.once(event, listener), exit: () => { child.exitCode = 0; events.emit('exit'); } };
  return child;
}

test("startSample runs the seed's command through $SHELL -c in the worktree, detached, without the Hive's env and with CI=1 (#474)", () => {
  const calls: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const child = fakeChild();
  const started = startSample('pnpm i && pnpm start', '/eval/worktree', (file, args, options) => { calls.push({ file, args, options }); return child; }, { SHELL: '/bin/zsh', PATH: '/bin', HIVE_SECRET: 's' });
  assert.equal(started, child);
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [['/bin/zsh', ['-c', 'pnpm i && pnpm start']]]);
  assert.deepEqual([calls[0]?.options.cwd, calls[0]?.options.detached, calls[0]?.options.stdio], ['/eval/worktree', true, 'ignore']);
  assert.deepEqual([calls[0]?.options.env?.CI, calls[0]?.options.env?.PATH, calls[0]?.options.env?.HIVE_SECRET], ['1', '/bin', undefined]);
});

test('stopSample sends SIGTERM to the process group, then SIGKILL after the grace when the shell has not exited (#474)', async () => {
  const kills: [number, string][] = [];
  await stopSample(fakeChild(4242), { kill: (pid, signal) => { kills.push([pid, signal]); }, graceMs: 20 });
  assert.deepEqual(kills, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  const polite = fakeChild(4343);
  const politeKills: [number, string][] = [];
  await stopSample(polite, { kill: (pid, signal) => { politeKills.push([pid, signal]); if (signal === 'SIGTERM') polite.exit(); }, graceMs: 60_000 });
  assert.deepEqual(politeKills, [[-4343, 'SIGTERM']]);
  await stopSample(fakeChild(), { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }, graceMs: 10 }); // a group already gone
});

test('waitReady answers once the URL gives a status below 500, and gives up at the deadline or when the command exits first (#474)', async () => {
  const url = 'http://127.0.0.1:5173/';
  let clock = 0;
  const tick = async (ms: number): Promise<void> => { clock += ms; };
  const statuses = [502, 404];
  assert.equal(await waitReady(url, { fetch: async () => ({ status: statuses.shift() ?? 200 }), now: () => clock, sleep: tick, exited: () => false, deadlineMs: 5_000 }), undefined);
  clock = 0;
  const refused = async (): Promise<{ status: number }> => { throw new Error('ECONNREFUSED'); };
  assert.equal(await waitReady(url, { fetch: refused, now: () => clock, sleep: tick, exited: () => false, deadlineMs: 3_000 }), `the sample did not start: no answer from ${url} in 3 s`);
  assert.equal(await waitReady(url, { fetch: refused, now: () => 0, sleep: async () => undefined, exited: () => true, deadlineMs: 3_000 }), 'the sample did not start: its command exited');
});
