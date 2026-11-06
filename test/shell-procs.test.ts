import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { childPids, shellCwd, strayAgents, wakeDir } from '../src/shell-procs.js';
import type { Exec } from '../src/types.js';
import { childWithGrandchild } from './process-probe.js';
import { listed, listingExec } from './process-table.js';
import { tempDir } from './temp-dir.js';

// A pgrep and an lsof that answer from a table keyed by the whole argv, and fail on anything else, as pgrep does on no match
const table = (answers: Record<string, string>): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    if (!(key in answers)) throw Object.assign(new Error('no match'), { code: 1 });
    return { stdout: answers[key] };
  };
  return { exec, calls };
};

test('shellCwd reads the shell under the pty\'s sh -c with pgrep, then its cwd with lsof in field mode, on darwin and linux alike (#696, #638)', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const { exec, calls } = table({ 'pgrep -P 4000': '4001\n', 'lsof -a -p 4001 -d cwd -Fn': 'p4001\nfcwd\nn/repo/src\n' });
    assert.equal(await shellCwd(4000, exec, platform), '/repo/src');
    assert.deepEqual(calls, [['pgrep', '-P', '4000'], ['lsof', '-a', '-p', '4001', '-d', 'cwd', '-Fn']], platform);
  }
});

test('shellCwd answers nothing with no pty, no shell under it, or an lsof that fails (#696)', async () => {
  assert.equal(await shellCwd(undefined, table({}).exec, 'darwin'), undefined);
  assert.equal(await shellCwd(4000, table({}).exec, 'darwin'), undefined, 'pgrep matched nothing');
  assert.equal(await shellCwd(4000, table({ 'pgrep -P 4000': '4001\n' }).exec, 'darwin'), undefined, 'lsof failed: the shell is already gone');
});

test('wakeDir keeps the held cwd while it is a directory on disk, else the start dir (#696)', async (t) => {
  const root = await tempDir(t, 'wake-');
  const held = join(root, 'src');
  await mkdir(held);
  assert.equal(await wakeDir(held, root), held);
  assert.equal(await wakeDir(join(root, 'gone'), root), root);
});

test('strayAgents names the agents under the shell that no captured session holds, skipping the shim itself (#696)', async () => {
  const { exec } = table({
    'pgrep -P 100': '200\n', // the pty's sh -c, then the shell
    'pgrep -lf -P 200': '301 /bin/sh /h/bin/claude fix it\n302 claude --resume abc\n303 vim notes\n',
    'pgrep -lf -P 301': '401 /usr/local/bin/claude --mcp-config x --session-id S1 fix it\n',
  });
  const shims = ['/h/bin/claude', '/h/bin/codex'];
  assert.deepEqual(await strayAgents(100, { captured: ['S1'], shims }, exec, 'darwin'), ['claude'], 'the resumed one only: S1 is captured');
  assert.deepEqual(await strayAgents(100, { captured: [], shims }, exec, 'darwin'), ['claude'], 'the shim\'s child is captured whatever its argv names (#932)');
  assert.deepEqual(await strayAgents(undefined, { captured: [], shims }, exec, 'darwin'), []);
});

test('a codex child of the codex shim is captured; a codex the shell runs itself (a passthrough execs) is stray (#932)', async () => {
  const { exec } = table({
    'pgrep -P 100': '200\n',
    'pgrep -lf -P 200': '301 /bin/sh /h/bin/codex\n302 node /usr/local/bin/codex --version\n',
    'pgrep -lf -P 301': '401 node /usr/local/bin/codex -c hooks.SessionStart=x --dangerously-bypass-hook-trust\n',
  });
  assert.deepEqual(await strayAgents(100, { captured: [], shims: ['/h/bin/claude', '/h/bin/codex'] }, exec, 'linux'), ['codex']);
});

const realExec: Exec = promisify(execFile);
const onWindows = { skip: process.platform !== 'win32' && 'Windows only: needs the real process table, runs on the Windows lane', timeout: 60_000 };
const PTY = 100;
const failingListing: Exec = async () => { throw new Error('Command failed: powershell.exe'); };

test('on win32 shellCwd answers undefined and runs nothing: no stock tool reads another process\'s cwd (#638)', async () => {
  const exec: Exec = async (file) => assert.fail(`no ${file} on win32`);
  assert.equal(await shellCwd(4000, exec, 'win32'), undefined);
  assert.equal(await shellCwd(undefined, exec, 'win32'), undefined);
});

test('on win32 childPids reads the children from one listing in pid order, and [] when the listing fails (#638)', async () => {
  const { exec } = listingExec([listed(330, PTY, 'b'), listed(120, PTY, 'a'), listed(210, 120, 'c')]);
  assert.deepEqual(await childPids(PTY, exec, 'win32'), [120, 330]);
  assert.deepEqual(await childPids(PTY, failingListing, 'win32'), []);
});

test('on win32 strayAgents finds claude three levels below the pty, as a native claude.exe in a path with a space and as an npm claude.cmd under cmd.exe (#638)', async () => {
  const { exec } = listingExec([
    listed(200, PTY, 'C:\\Program Files\\Git\\usr\\bin\\sh.exe -c "exec pwsh"'), // Git's bin\sh.exe starts usr\bin\sh.exe
    listed(300, 200, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    listed(401, 300, '"C:\\Users\\a b\\.local\\bin\\claude.exe" --resume x'),
    listed(402, 300, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd --resume y"'),
    listed(501, 402, '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume y'),
    listed(403, 300, '"C:\\Program Files\\Git\\cmd\\git.exe" grep claude'), // a word named claude is not the program
    listed(404, 300, null), // a process the user cannot read
    listed(600, 1, '"C:\\Users\\a\\.local\\bin\\claude.exe"'), // another terminal's
  ]);
  assert.deepEqual(await strayAgents(PTY, { captured: [], shims: [] }, exec, 'win32'), ['claude', 'claude']);
});

test('on win32 strayAgents skips a shim\'s line and its whole subtree, and a line naming a captured session (#638)', async () => {
  const shim = 'C:\\h\\bin\\claude';
  const { exec } = listingExec([
    listed(200, PTY, 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'),
    listed(301, 200, `C:\\Program Files\\Git\\usr\\bin\\sh.exe ${shim} fix it`),
    listed(401, 301, 'C:\\Users\\a\\.local\\bin\\claude.exe --mcp-config x fix it'),
    listed(501, 401, 'C:\\Users\\a\\.local\\bin\\CLAUDE.EXE --print'), // deeper under the shim: pruned with it
    listed(302, 200, 'C:\\Users\\a\\.local\\bin\\claude.exe --resume S1'),
    listed(303, 200, 'C:\\Users\\a\\.local\\bin\\Codex.exe'), // compared case-insensitively
  ]);
  assert.deepEqual(await strayAgents(PTY, { captured: ['S1'], shims: [shim] }, exec, 'win32'), ['codex']);
});

test('on win32 strayAgents answers [] with no pty or a listing that fails (#638)', async () => {
  assert.deepEqual(await strayAgents(undefined, { captured: [], shims: [] }, failingListing, 'win32'), []);
  assert.deepEqual(await strayAgents(PTY, { captured: [], shims: [] }, failingListing, 'win32'), []);
});

test('on the Windows lane: childPids of a process that started one child lists that child, from the real table (#638)', onWindows, async (t) => {
  const { pid, grandchild } = await childWithGrandchild(t);
  const children = await childPids(pid, realExec, process.platform);
  // includes, not equal: Windows may give the child a console host of its own, listed as its child too
  assert.ok(children.includes(grandchild), `${grandchild} in ${children.join(', ')}`);
});
