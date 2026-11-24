import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { runners } from '../src/agents/registry.js';
import { mcpConfigPattern } from '../src/hooks-settings.js';
import { isStrayAlive, killStray } from '../src/spawn.js';
import type { Exec } from '../src/types.js';
import { childrenOf, listProcesses, matching, parseProcesses, type ProcessRow, subtree } from '../src/win-procs.js';
import { NO_PROCESS_LIST } from './process-list.js';
import { childWithGrandchild, gone } from './process-probe.js';
import { listed, listingExec } from './process-table.js';

const POWERSHELL = /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/;
const PTY = 'a3f1c2d4-0000-4000-8000-000000000001';
// A PowerShell cmdlet name (Verb-Noun): every one outside Core makes a cold 5.1 autoload its module first (#970)
const CMDLET = /\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/;
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

test('parseProcesses reads one `<pid> <ppid> <base64>` row per line: spaces, a tab, a line break and a non-ASCII path survive, and a null CommandLine is \'\' (#970)', () => {
  const tricky = 'sh.exe -c "a\tb\nc"';
  const accented = 'C:\\Usuários\\joão\\claude.exe --mcp-config x';
  assert.deepEqual(
    parseProcesses(`4 0 \r\n200 100 ${b64(tricky)}\r\n201 100 ${b64(accented)}\r\n`),
    [{ pid: 4, ppid: 0, line: '' }, { pid: 200, ppid: 100, line: tricky }, { pid: 201, ppid: 100, line: accented }],
  );
});

test('parseProcesses skips a malformed line and answers [] for an empty stdout (#970)', () => {
  const good = `7 1 ${b64('x')}`;
  for (const bad of ['7 1', 'x 1 eA==', '7 -1 eA==', '1.5 0 eA==', '7  1 eA==', '7 1 not base64!', '[{"ProcessId":7,"ParentProcessId":1,"CommandLine":"x"}]']) {
    assert.deepEqual(parseProcesses(`${bad}\r\n${good}\r\n`), [{ pid: 7, ppid: 1, line: 'x' }], bad);
  }
  for (const stdout of ['', '\r\n', 'garbage']) assert.deepEqual(parseProcesses(stdout), [], JSON.stringify(stdout));
});

test('childrenOf gives the direct children in ascending pid order, never the pid itself (#638)', () => {
  const rows: ProcessRow[] = [
    { pid: 0, ppid: 0, line: '' }, // the System Idle Process is its own parent
    { pid: 330, ppid: 100, line: 'c' },
    { pid: 120, ppid: 100, line: 'a' },
    { pid: 210, ppid: 120, line: 'b' },
  ];
  assert.deepEqual(childrenOf(rows, 100), [120, 330]);
  assert.deepEqual(childrenOf(rows, 0), []);
  assert.deepEqual(childrenOf(rows, 999), []);
});

test('matching reads a pattern as pgrep -f does: mcpConfigPattern\'s escaped dots match the file and not a look-alike (#638)', () => {
  const rows: ProcessRow[] = [
    { pid: 1, ppid: 0, line: `claude.exe --mcp-config C:\\t\\hive-runs\\${PTY}\\${PTY}.mcp.json` },
    { pid: 2, ppid: 0, line: `claude.exe --mcp-config C:\\t\\${PTY}xmcpxjson` },
    { pid: 3, ppid: 0, line: 'claude.exe --mcp-config C:\\t\\other.mcp.json' },
  ];
  assert.deepEqual(matching(rows, mcpConfigPattern(PTY)).map((row) => row.pid), [1]);
});

test('subtree walks every level under the pid, prunes a row with all it holds, and ends on a ppid loop from a reused pid (#638)', () => {
  const rows: ProcessRow[] = [
    { pid: 200, ppid: 100, line: 'sh' },
    { pid: 300, ppid: 200, line: 'pwsh' },
    { pid: 310, ppid: 200, line: 'shim' },
    { pid: 400, ppid: 300, line: 'agent' },
    { pid: 410, ppid: 310, line: 'under the shim' },
    { pid: 100, ppid: 400, line: 'the root, whose parent pid Windows reused' },
  ];
  assert.deepEqual(subtree(rows, 100, () => false).map((row) => row.pid), [200, 300, 310, 400, 410]);
  assert.deepEqual(subtree(rows, 100, (row) => row.line === 'shim').map((row) => row.pid), [200, 300, 400]);
  assert.deepEqual(subtree(rows, 999, () => false), []);
});

test('listProcesses runs Windows PowerShell 5.1 by full path with the WMI listing encoded, through the caller\'s exec, with room for a full table (#638)', async () => {
  const calls: { file: string; args: string[]; maxBuffer?: number }[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, maxBuffer: opts?.maxBuffer });
    return { stdout: `7 1 ${b64('x')}\r\n` };
  };
  assert.deepEqual(await listProcesses(exec), [{ pid: 7, ppid: 1, line: 'x' }]);
  assert.equal(calls.length, 1);
  const [{ file, args, maxBuffer }] = calls;
  assert.match(file, POWERSHELL);
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand']);
  assert.equal(args.length, 6);
  const script = Buffer.from(args[5], 'base64').toString('utf16le');
  assert.ok(script.includes("[wmisearcher]'SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process'"), script);
  assert.doesNotMatch(script, CMDLET, 'no cmdlet: a cold 5.1 would autoload its module first and spend the 15 s bound there (#970)');
  assert.ok((maxBuffer ?? 0) > 1024 * 1024, 'more than execFile\'s default 1 MiB');
});

test('parseProcesses reads a listing that starts with a UTF-8 byte order mark (#638)', () => {
  assert.deepEqual(parseProcesses(`\uFEFF7 1 ${b64('x')}\r\n`), [{ pid: 7, ppid: 1, line: 'x' }]);
});

test('listProcesses caps the PowerShell run and drops PSModulePath, so a stuck WMI query never holds the boot and 5.1 loads its own modules (#638)', async () => {
  const seen: { timeout?: number; env?: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (_file, _args, opts) => {
    seen.push({ timeout: opts?.timeout, env: opts?.env });
    return { stdout: '[]' };
  };
  await listProcesses(exec, { PSModulePath: 'C:\\pwsh7\\Modules', Path: 'C:\\bin' });
  const [{ timeout, env }] = seen;
  assert.ok((timeout ?? 0) > 0, 'a timeout is set');
  assert.deepEqual(env, { Path: 'C:\\bin' });
});

test('listProcesses rejects when its exec fails: a failed listing is never read as an empty table (#638)', async () => {
  const failing: Exec = async () => { throw new Error('Command failed: powershell.exe'); };
  await assert.rejects(listProcesses(failing), /powershell/);
});

const realExec: Exec = promisify(execFile);
const onWindows = { skip: process.platform !== 'win32' && 'Windows only: needs the real process table, runs on the Windows lane', timeout: 60_000 };
const OTHER = 'b7e2d3c4-0000-4000-8000-000000000002';
const claudeLine = (pty: string): string => `"C:\\Users\\a b\\.local\\bin\\claude.exe" --mcp-config C:\\t\\hive-runs\\${pty}\\${pty}.mcp.json`;

test('on win32 isStrayAlive matches the runner\'s stray pattern in one listing: true for its own .mcp.json, false when only another pty\'s is listed (#638)', async () => {
  const pattern = runners.claude.strayPattern(PTY);
  assert.equal(await isStrayAlive(pattern, listingExec([listed(400, 300, claudeLine(PTY))]).exec, 'win32'), true);
  assert.equal(await isStrayAlive(pattern, listingExec([listed(401, 300, claudeLine(OTHER))]).exec, 'win32'), false);
});

test('on win32 killStray kills every matching row\'s tree with taskkill /T /F /PID and answers whether one matched (#638)', async () => {
  const pattern = runners.claude.strayPattern(PTY);
  const { exec, calls } = listingExec([listed(400, 300, claudeLine(PTY)), listed(401, 300, claudeLine(OTHER)), listed(402, 400, claudeLine(PTY))]);
  assert.equal(await killStray(pattern, exec, 'win32'), true);
  assert.deepEqual(calls, [['taskkill', '/T', '/F', '/PID', '400'], ['taskkill', '/T', '/F', '/PID', '402']]);
  const none = listingExec([listed(401, 300, claudeLine(OTHER))]);
  assert.equal(await killStray(pattern, none.exec, 'win32'), false);
  assert.deepEqual(none.calls, [], 'no match, no taskkill');
});

test('on win32 killStray and isStrayAlive reject when the listing\'s exec fails, even with exit 1, as a failing pkill does (#638)', async () => {
  const failing: Exec = async () => { throw Object.assign(new Error('Command failed: powershell.exe'), { code: 1 }); };
  await assert.rejects(killStray(PTY, failing, 'win32'), /powershell/);
  await assert.rejects(isStrayAlive(PTY, failing, 'win32'), /powershell/);
});

test('off win32 killStray and isStrayAlive still run pkill -f and pgrep -f with the pattern; exit 1 is no match, anything else rejects (#638)', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: '' };
    };
    assert.equal(await killStray(PTY, exec, platform), true);
    assert.equal(await isStrayAlive(PTY, exec, platform), true);
    assert.deepEqual(calls, [['pkill', '-f', '--', PTY], ['pgrep', '-f', '--', PTY]], platform);
    const noMatch: Exec = async () => { throw Object.assign(new Error('exit 1'), { code: 1 }); };
    assert.equal(await killStray(PTY, noMatch, platform), false);
    assert.equal(await isStrayAlive(PTY, noMatch, platform), false);
    const refused: Exec = async () => { throw Object.assign(new Error('exit 3'), { code: 3 }); };
    await assert.rejects(isStrayAlive(PTY, refused, platform), /exit 3/);
  }
});

// moved from test/spawn.test.ts (#638): pgrep and pkill against the real table, wherever pgrep can read it
test('killStray and isStrayAlive resolve false when no process matches', { skip: NO_PROCESS_LIST }, async () => {
  assert.equal(await killStray('definitely-not-running-worker-xyz', realExec, process.platform), false);
  assert.equal(await isStrayAlive('definitely-not-running-worker-xyz', realExec, process.platform), false);
});

test('on the Windows lane: isStrayAlive sees a node whose argv holds a unique pattern, killStray takes it and the child it started, and then both answer false (#638)', onWindows, async (t) => {
  const marker = `hive-638-${randomUUID()}`;
  const { pid, grandchild } = await childWithGrandchild(t, [marker]);
  assert.equal(await isStrayAlive(marker, realExec, process.platform), true);
  assert.equal(await killStray(marker, realExec, process.platform), true);
  assert.equal(await gone(pid), true, 'the matched node');
  assert.equal(await gone(grandchild), true, 'the child it started, through taskkill /T');
  assert.equal(await isStrayAlive(marker, realExec, process.platform), false);
  assert.equal(await killStray(marker, realExec, process.platform), false);
});
