import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureChromium, keepShots, mcpBinary, mcpConfig, parseClicks, type SampleChild, scenarioResults, TESTER_SCHEMA, TESTER_TIMEOUT_MS, TESTER_TOOLS, testerPrompt, testerRefusal, walkScenarios, startSample, stopSample, waitReady } from '../../src/benchmark/browser.js';
import type { HeadlessInput, HeadlessResult } from '../../src/headless-run.js';
import type { BenchScenario } from '../../src/types.js';
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

type FakeChild = SampleChild & { exitCode: number | null; exit(): void; fail(): void };
function fakeChild(pid = 4242): FakeChild {
  const events = new EventEmitter();
  const child: FakeChild = { pid, exitCode: null, once: (event, listener) => events.once(event, listener), exit: () => { child.exitCode = 0; events.emit('exit'); }, fail: () => { events.emit('error', new Error('spawn ENOENT')); } };
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
  const kills: [number, string | 0][] = [];
  await stopSample(fakeChild(4242), { kill: (pid, signal) => { kills.push([pid, signal]); }, graceMs: 20 });
  assert.deepEqual(kills, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  const polite = fakeChild(4343);
  const politeKills: [number, string][] = [];
  await stopSample(polite, { kill: (pid, signal) => { if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); politeKills.push([pid, signal]); if (signal === 'SIGTERM') polite.exit(); }, graceMs: 60_000 });
  assert.deepEqual(politeKills, [[-4343, 'SIGTERM']]);
  await stopSample(fakeChild(), { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }, graceMs: 10 }); // a group already gone
});

test('stopSample still sends SIGKILL to the group after the grace when the shell exited on SIGTERM (a stubborn child outlives it) (#474)', async () => {
  const shell = fakeChild(4444);
  const kills: [number, string | 0][] = [];
  await stopSample(shell, { kill: (pid, signal) => { kills.push([pid, signal]); if (signal === 'SIGTERM') shell.exit(); }, graceMs: 20 });
  assert.deepEqual(kills, [[-4444, 'SIGTERM'], [-4444, 0], [-4444, 'SIGKILL']]);
});

test('a walk whose headless run rejects counts its scenarios failed and the other walks still count (#474)', async (t) => {
  const dir = await tempDir(t, 'walk-');
  const lines: string[] = [];
  const headless = async (): Promise<HeadlessResult> => { throw new Error('spawn claude ENOENT /secret/path'); };
  const walks = await walkScenarios(
    { tester: { agent: 'claude' }, scenarios: SCENARIOS, walks: 2, url: 'http://127.0.0.1:5173/', screens: join(dir, 'screens'), chromiumPath: '/pw/chrome', mcpBin: '/pkg/cli.js' },
    { headless, log: (line) => lines.push(line), signal: new AbortController().signal, tmpRoot: dir },
  );
  assert.equal(walks.length, 2);
  assert.ok(walks.flat().every((c) => !c.passed && c.notes.startsWith("the tester's walk")));
  assert.equal(lines.some((l) => l.includes('/secret/path')), false);
});

test('walkScenarios stops between walks once the signal aborted (#474)', async (t) => {
  const dir = await tempDir(t, 'walk-');
  const controller = new AbortController();
  let calls = 0;
  const headless = async (): Promise<HeadlessResult> => { calls += 1; controller.abort(); return { answer: '{}' }; };
  await assert.rejects(walkScenarios(
    { tester: { agent: 'claude' }, scenarios: SCENARIOS, walks: 3, url: 'http://127.0.0.1:5173/', screens: join(dir, 'screens'), chromiumPath: '/pw/chrome', mcpBin: '/pkg/cli.js' },
    { headless, log: () => undefined, signal: controller.signal, tmpRoot: dir },
  ));
  assert.equal(calls, 1);
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

const SCENARIOS: BenchScenario[] = [{ id: 'S1', title: 'Sign in', text: 'Open it. Expected: the list shows.' }, { id: 'S2', title: 'Add an item', text: 'Click add. Expected: a row appears.' }];

test('testerPrompt opens the URL, lists every scenario, forbids edits and asks for every result; the intro goes before the scenarios (#474)', () => {
  const prompt = testerPrompt({ url: 'http://127.0.0.1:5173/', scenarios: SCENARIOS, intro: 'INTRO' });
  for (const part of ['http://127.0.0.1:5173/', '## S1 · Sign in', '## S2 · Add an item', 'Never edit', '"scenarios"', '<scenario id>-<step number>.png', 'INTRO']) assert.ok(prompt.includes(part), part);
  assert.ok(prompt.indexOf('INTRO') < prompt.indexOf('## S1'));
});

test('parseClicks keeps one entry per seed scenario: a missing one fails, passed only when true, strings only (#105, #474)', () => {
  assert.deepEqual(parseClicks([{ scenario: 'S2', passed: 'yes', notes: 7, screenshots: ['S2-1.png', 3] }, { scenario: 'S9', passed: true }], SCENARIOS), [
    { scenario: 'S1', passed: false, notes: 'not reported by the tester', screenshots: [] },
    { scenario: 'S2', passed: false, notes: '', screenshots: ['S2-1.png'] },
  ]);
  assert.deepEqual(parseClicks('nothing', SCENARIOS).map((c) => c.passed), [false, false]);
});

test('the tester is refused for an agent whose headless run takes no MCP config (#474)', () => {
  assert.equal(testerRefusal('claude'), undefined);
  assert.equal(testerRefusal('codex'), 'codex cannot run the tester (no MCP config in a headless run)');
});

test("walkScenarios runs one tester per walk in a bare temp folder holding only the MCP config, keeps each walk's shots under its number and counts the walks per scenario (#474)", async (t) => {
  const dir = await tempDir(t, 'walk-');
  const tmpRoot = join(dir, 'tmp');
  await mkdir(tmpRoot);
  const screens = join(dir, 'screens');
  const inputs: HeadlessInput[] = [];
  const headless = async (input: HeadlessInput): Promise<HeadlessResult> => {
    inputs.push(input);
    assert.deepEqual((await readdir(input.cwd ?? '')).sort(), ['mcp.json', 'screens']);
    await writeFile(join(input.cwd ?? '', 'S1-1.png'), 'png');
    const second = inputs.length === 2;
    return { answer: JSON.stringify({ scenarios: [{ scenario: 'S1', passed: true, notes: 'ok', screenshots: ['S1-1.png'] }, { scenario: 'S2', passed: second, notes: '', screenshots: [] }] }) };
  };
  const walks = await walkScenarios(
    { tester: { agent: 'claude', model: 'sonnet' }, scenarios: SCENARIOS, walks: 2, url: 'http://127.0.0.1:5173/', screens, chromiumPath: '/pw/chrome', mcpBin: '/pkg/cli.js' },
    { headless, log: () => undefined, signal: new AbortController().signal, tmpRoot },
  );
  assert.deepEqual(scenarioResults(SCENARIOS, walks), [
    { id: 'S1', passed: 2, total: 2, screenshots: ['1-S1-1.png', '2-S1-1.png'] },
    { id: 'S2', passed: 1, total: 2, screenshots: [] },
  ]);
  assert.deepEqual((await readdir(screens)).sort(), ['1-S1-1.png', '2-S1-1.png']);
  assert.deepEqual(await readdir(tmpRoot), [], "every walk's temp folder is gone");
  for (const input of inputs) {
    assert.deepEqual([input.agent, input.model, input.schema, input.allowedTools, input.timeoutMs, input.readOnlyTools], ['claude', 'sonnet', TESTER_SCHEMA, TESTER_TOOLS, TESTER_TIMEOUT_MS, undefined]);
    assert.ok(input.mcpConfig?.startsWith(tmpRoot) && input.mcpConfig.endsWith('mcp.json'));
  }
  assert.ok(TESTER_TOOLS.every((name) => name.startsWith('mcp__playwright__browser_')) && !TESTER_TOOLS.some((name) => /evaluate|run_code|file_upload|install|cookie|storage|network/.test(name)));
});

test('a walk that fails or answers no JSON counts each of its scenarios failed with the reason; the other walks still count (#474)', async (t) => {
  const dir = await tempDir(t, 'walk-');
  const lines: string[] = [];
  let n = 0;
  const headless = async (): Promise<HeadlessResult> => {
    n += 1;
    if (n === 1) return { failure: 'timed out after 7200000 ms', detail: 'x' };
    if (n === 2) return { answer: 'not json' };
    return { answer: JSON.stringify({ scenarios: [{ scenario: 'S1', passed: true, notes: '', screenshots: [] }, { scenario: 'S2', passed: true, notes: '', screenshots: [] }] }) };
  };
  const walks = await walkScenarios(
    { tester: { agent: 'claude' }, scenarios: SCENARIOS, walks: 3, url: 'http://127.0.0.1:5173/', screens: join(dir, 'screens'), chromiumPath: '/pw/chrome', mcpBin: '/pkg/cli.js' },
    { headless, log: (line) => lines.push(line), signal: new AbortController().signal, tmpRoot: dir },
  );
  assert.deepEqual(walks[0]?.map((c) => [c.scenario, c.passed, c.notes]), [['S1', false, "the tester's walk 1 failed: timed out after 7200000 ms"], ['S2', false, "the tester's walk 1 failed: timed out after 7200000 ms"]]);
  assert.deepEqual(walks[1]?.map((c) => c.passed), [false, false]);
  assert.deepEqual(scenarioResults(SCENARIOS, walks).map((r) => [r.passed, r.total]), [[1, 3], [1, 3]]);
  assert.deepEqual(lines, ['tester walk 1: timed out after 7200000 ms', 'tester walk 2: no JSON answer']);
});
