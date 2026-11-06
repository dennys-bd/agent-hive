import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
import { runners } from '../src/agents/registry.js';
import { commandChannel, createConsoleStore } from '../src/console.js';
import { feedConsole } from '../src/console-feed.js';
import { killTree } from '../src/kill-tree.js';
import { createPtyHost, type PtyHost } from '../src/pty-host.js';
import { SECRET_HEADER } from '../src/secret.js';
import { killStray } from '../src/spawn.js';
import { launchInternalPty } from '../src/spawn-internal.js';
import type { Exec, PtyLaunch } from '../src/types.js';
import { gone } from './process-probe.js';
import { SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

const onWindows = { skip: process.platform !== 'win32' && 'Windows only: drives a real ConPTY through node-pty, runs on the Windows lane', timeout: 60_000 };
const realExec: Exec = promisify(execFile);
const GRID = { cols: 100, rows: 30 };
const WAIT_MS = 20_000;
const POLL_MS = 50;
const MAX_LINES = 1000;

// The fake agent (#644): node by its full path on this script, under sh.exe in the ConPTY. It prints its grid, every size change, what it
// reads (raw, so é✓ arrives as typed) and, asked with --child, the pid of a child it starts; q ends it. CommonJS: the temp dir has no package.json.
const AGENT = String.raw`
const { spawn } = require('node:child_process');
const say = (line) => process.stdout.write(line + '\r\n');
say('ready ' + process.stdout.columns + 'x' + process.stdout.rows);
if (process.argv.includes('--child')) say('child ' + spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid);
say('pid ' + process.pid);
process.stdout.on('resize', () => say('size ' + process.stdout.columns + 'x' + process.stdout.rows));
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => (data === 'q' ? process.exit(0) : say('got:' + data.replace(/\r/g, ''))));
`;

// ConPTY repaints with cursor moves and erases between lines: the escapes go before matching
async function until(read: () => string, pattern: RegExp): Promise<RegExpExecArray> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const match = pattern.exec(stripVTControlCharacters(read()));
    if (match) return match;
    if (Date.now() > deadline) assert.fail(`no ${pattern} in ${JSON.stringify(stripVTControlCharacters(read()))}`);
    await sleep(POLL_MS);
  }
}

// /hooks/exit's stand-in: each POST as `<url> <x-hive-pty> <secret header>`
async function hooksServer(t: TestContext): Promise<{ port: number; posts: string[] }> {
  const posts: string[] = [];
  const server = createServer((req, res) => {
    posts.push(`${req.url} ${req.headers['x-hive-pty']} ${req.headers[SECRET_HEADER]}`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, posts };
}

interface Lane { host: PtyHost; ptyId: string; output(): string; exits(): number; ended: Promise<[number, boolean]>; posts: string[] }

// A run through the daemon's own spawn, host and launch: the fake agent whose argv holds <ptyId>.mcp.json, as claude's --mcp-config does
async function lane(t: TestContext, extra: Partial<PtyLaunch> = {}, agentArgs: readonly string[] = []): Promise<Lane> {
  const { nodePtySpawn } = await import('../src/pty-spawn.js');
  const dir = await tempDir(t, 'conpty-');
  const script = join(dir, 'agent.cjs');
  await writeFile(script, AGENT);
  const secretFile = join(dir, 'hive.secret');
  await writeFile(secretFile, `${SECRET_HEADER}: ${SECRET}\n`);
  const { port, posts } = await hooksServer(t);
  const host = createPtyHost(nodePtySpawn);
  const ptyId = randomUUID();
  const launch: PtyLaunch = {
    ptyId, slug: 'hive-644-lane', cwd: dir, port, size: GRID,
    agent: { command: process.execPath, argv: [script, '--mcp-config', join(dir, `${ptyId}.mcp.json`), ...agentArgs] }, ...extra,
  };
  let [chunks, exits] = ['', 0];
  // a run's tmp removal is spawn-internal.test.ts's to check
  const handle = launchInternalPty(launch, { onError: () => undefined, onExit: () => { exits += 1; } }, { ptys: host, secretFile });
  t.after(() => handle.kill());
  await handle.started;
  const ended = new Promise<[number, boolean]>((resolve) => {
    host.subscribe(ptyId, (data) => { chunks += data; }, (code, killed) => resolve([code, killed]));
  });
  return { host, ptyId, output: () => chunks, exits: () => exits, ended, posts };
}

test('on the Windows lane a run under ConPTY prints, reads 132 columns after a resize, round-trips é✓, exits once through the pool and posts its trailer with its pty id (#644)', onWindows, async (t) => {
  const run = await lane(t);
  await until(run.output, /ready 100x30/);
  assert.equal(run.host.resize(run.ptyId, 132, GRID.rows), true);
  await until(run.output, /size 132x30/);
  run.host.write(run.ptyId, 'é✓\r');
  await until(run.output, /got:é✓/);
  run.host.write(run.ptyId, 'q');
  assert.deepEqual(await run.ended, [0, false], 'the shell exits with its trailer\'s curl, and nothing killed it');
  assert.equal(run.exits(), 1, 'the pool hears the pty\'s exit once');
  // curl posts before the shell exits: the request is in by the pty's exit. The secret header proves curl read @"$HIVE_SECRET_FILE"'s Windows path
  assert.deepEqual(run.posts, [`/hooks/exit ${run.ptyId} ${SECRET}`]);
});

test('on the Windows lane a redraw at the pty\'s own grid reaches the program as two size changes, one row off and then back (#389, #644)', onWindows, async (t) => {
  const run = await lane(t);
  await until(run.output, /ready 100x30/);
  assert.equal(run.host.resize(run.ptyId, GRID.cols, GRID.rows, true), true);
  await until(run.output, /size 100x29[\s\S]*size 100x30/);
});

test('on the Windows lane a run command whose line exits 3 ends its console with status 3 (#537, #644)', onWindows, async (t) => {
  const run = await lane(t, { terminal: true, run: { command: 'exit 3', env: {} } });
  // fed in the same turn as the spawn, as server-spawn.ts feeds it: no pty event can land before the subscribe
  const store = createConsoleStore(() => MAX_LINES);
  const codes: number[] = [];
  const isFed = feedConsole({ ptys: run.host, consoleStore: store }, commandChannel('lane', 'exit3'), run.ptyId, {
    label: `#${run.ptyId}`, onTimeout: () => undefined, onEnd: (code) => codes.push(code),
  });
  assert.equal(isFed, true);
  assert.deepEqual(await run.ended, [3, false]);
  assert.deepEqual([codes, store.channels()[0]?.status], [[3], 'failed']);
});

test('on the Windows lane the tab\'s kill, killStray on claude\'s stray pattern, ends the fake agent whose argv holds <ptyId>.mcp.json and the child it started (#638, #644)', onWindows, async (t) => {
  const run = await lane(t, {}, ['--child']);
  const [, child] = await until(run.output, /child (\d+)/);
  // the pty's kill does not reach a child started with stdio ignored: a failed assertion below must not leave it running on the runner
  t.after(() => killTree(Number(child), 'win32', realExec));
  const [, agent] = await until(run.output, /pid (\d+)/);
  assert.equal(await killStray(runners.claude.strayPattern(run.ptyId), realExec, 'win32'), true);
  assert.equal(await gone(Number(agent)), true, 'the fake agent');
  assert.equal(await gone(Number(child)), true, 'the child it started, through taskkill /T');
});
