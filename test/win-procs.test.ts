import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpConfigPattern } from '../src/hooks-settings.js';
import type { Exec } from '../src/types.js';
import { childrenOf, listProcesses, matching, parseProcesses, type ProcessRow, subtree } from '../src/win-procs.js';

const POWERSHELL = /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/;
const PTY = 'a3f1c2d4-0000-4000-8000-000000000001';

test('parseProcesses reads ConvertTo-Json\'s array and its single object, a null CommandLine as \'\', and drops a row without an integer pid (#638)', () => {
  assert.deepEqual(
    parseProcesses('[{"ProcessId":4,"ParentProcessId":0,"CommandLine":null},{"ProcessId":200,"ParentProcessId":100,"CommandLine":"sh.exe -c x"}]'),
    [{ pid: 4, ppid: 0, line: '' }, { pid: 200, ppid: 100, line: 'sh.exe -c x' }],
  );
  assert.deepEqual(parseProcesses('{"ProcessId":200,"ParentProcessId":100,"CommandLine":"sh.exe"}'), [{ pid: 200, ppid: 100, line: 'sh.exe' }], 'one row: an object, not an array');
  assert.deepEqual(
    parseProcesses('[{"ProcessId":1.5,"ParentProcessId":0,"CommandLine":"a"},{"ProcessId":"7","ParentProcessId":0,"CommandLine":"b"},{"ParentProcessId":0,"CommandLine":"c"},null,3]'),
    [],
  );
  assert.deepEqual(parseProcesses('[{"ProcessId":9,"CommandLine":"x"}]'), [{ pid: 9, ppid: -1, line: 'x' }], 'no parent: still matchable by its line');
});

test('parseProcesses answers [] for malformed JSON, an empty stdout and a JSON that holds no row (#638)', () => {
  for (const stdout of ['[{"ProcessId":', '', 'null', '"text"']) assert.deepEqual(parseProcesses(stdout), [], stdout);
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

test('listProcesses runs Windows PowerShell 5.1 by full path with the CIM listing encoded, through the caller\'s exec, with room for a full table (#638)', async () => {
  const calls: { file: string; args: string[]; maxBuffer?: number }[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, maxBuffer: opts?.maxBuffer });
    return { stdout: '{"ProcessId":7,"ParentProcessId":1,"CommandLine":"x"}' };
  };
  assert.deepEqual(await listProcesses(exec), [{ pid: 7, ppid: 1, line: 'x' }]);
  assert.equal(calls.length, 1);
  const [{ file, args, maxBuffer }] = calls;
  assert.match(file, POWERSHELL);
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand']);
  assert.equal(args.length, 6);
  const script = Buffer.from(args[5], 'base64').toString('utf16le');
  assert.ok(script.includes('Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress'), script);
  assert.ok((maxBuffer ?? 0) > 1024 * 1024, 'more than execFile\'s default 1 MiB');
});

test('listProcesses rejects when its exec fails: a failed listing is never read as an empty table (#638)', async () => {
  const failing: Exec = async () => { throw new Error('Command failed: powershell.exe'); };
  await assert.rejects(listProcesses(failing), /powershell/);
});
