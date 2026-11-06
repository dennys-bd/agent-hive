import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { createConsoleStore } from '../src/console.js';
import { customShell, type FormatContext, runFormatter } from '../src/format-run.js';
import { posixShell, posixShellEnv, resolvePosixShell, type ShellLookups } from '../src/posix-shell.js';
import { tempDir } from './temp-dir.js';

const GIT = 'C:\\Program Files\\Git';
const BIN_SH = `${GIT}\\bin\\sh.exe`;
const USR_SH = `${GIT}\\usr\\bin\\sh.exe`;
const EXEC_PATH = (flavour: string): string => `C:/Program Files/Git/${flavour}/libexec/git-core`; // git answers with forward slashes

// git answers `execPath`; only the files in `present` exist
const lookups = (execPath: string | undefined, present: string[]): ShellLookups => ({ gitExecPath: () => execPath, exists: (path) => present.includes(path) });
const namesGitForWindows = (err: unknown): boolean => err instanceof Error && /Git for Windows/.test(err.message) && !err.message.includes('\n');

test('on win32 Git\'s root is three levels above git --exec-path, mingw64 or ucrt64, and Git\'s launcher bin\\sh.exe comes first (#631)', () => {
  for (const flavour of ['mingw64', 'ucrt64']) {
    assert.deepEqual(resolvePosixShell('win32', lookups(EXEC_PATH(flavour), [USR_SH, BIN_SH])), { shell: BIN_SH, gitRoot: GIT }, flavour);
  }
});

test('on win32 a layout with no launcher (MinGit, portable) answers usr\\bin\\sh.exe (#631)', () => {
  assert.deepEqual(resolvePosixShell('win32', lookups(EXEC_PATH('mingw64'), [USR_SH])), { shell: USR_SH, gitRoot: GIT });
});

test('on win32 no git, or a git with neither sh.exe, is one line that names Git for Windows (#631)', () => {
  assert.throws(() => resolvePosixShell('win32', lookups(undefined, [BIN_SH])), namesGitForWindows);
  assert.throws(() => resolvePosixShell('win32', lookups(EXEC_PATH('mingw64'), [])), namesGitForWindows);
});

test('darwin and linux answer /bin/sh and never run git nor look a file up (#631)', () => {
  const untouched: ShellLookups = { gitExecPath: () => assert.fail('git ran'), exists: () => assert.fail('a file was looked up') };
  for (const platform of ['darwin', 'linux'] as const) assert.deepEqual(resolvePosixShell(platform, untouched), { shell: '/bin/sh' }, platform);
});

test('posixShellEnv keeps MSYS from rewriting the Hive\'s arguments on win32 only (#631)', () => {
  assert.deepEqual(posixShellEnv('win32'), { MSYS2_ARG_CONV_EXCL: '*' });
  assert.deepEqual(posixShellEnv('darwin'), {});
  assert.deepEqual(posixShellEnv('linux'), {});
});

const ON_WINDOWS = { skip: process.platform !== 'win32' };
const system32 = (): string => win32.join(process.env.SystemRoot ?? assert.fail('no SystemRoot'), 'System32');

test('customShell: on win32 a SHELL is ignored (Git Bash\'s /usr/bin/bash cannot be spawned by node), elsewhere it is kept; unset is the POSIX shell (#631)', () => {
  const posix = 'C:\\Git\\bin\\sh.exe'; // any value: customShell never resolves one itself
  assert.equal(customShell('win32', { SHELL: '/usr/bin/bash' }, posix), posix);
  assert.equal(customShell('darwin', { SHELL: '/bin/zsh' }, '/bin/sh'), '/bin/zsh');
  assert.equal(customShell('linux', {}, '/bin/sh'), '/bin/sh');
});

test('on the Windows lane: a custom formatter\'s line runs through Git\'s sh.exe with System32 ahead of Git on PATH; its output and its exit code come back (#631)', ON_WINDOWS, async (t) => {
  const saved = process.env.PATH ?? '';
  process.env.PATH = `${system32()};${saved}`;
  t.after(async () => { process.env.PATH = saved; });
  const dir = await tempDir(t, 'fmt-sh-');
  const ctx: FormatContext = { cwd: dir, file: win32.join(dir, 'a.sql'), workspace: { name: 'ui', env: {} }, label: 'ui · a.sql', consoleStore: createConsoleStore(() => 5000) };
  assert.deepEqual(await runFormatter({ kind: 'custom', name: 'up', command: 'tr a-z A-Z' }, 'select 1\n', ctx), { text: 'SELECT 1\n' });
  const failed = await runFormatter({ kind: 'custom', name: 'bad', command: 'cat > /dev/null; exit 3' }, 'x\n', ctx);
  assert.ok('error' in failed);
  assert.equal(failed.error, 'exit code 3');
});

// The daemon's env with PATH alone set to `path`: Windows names it Path, and a second key in another case would reach the child twice
const withPath = (path: string): NodeJS.ProcessEnv =>
  ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH')), PATH: path });

test('on the Windows lane: with PATH cut to Git\\cmd and System32, Git for Windows\' default, sh.exe -c finds curl, cat and printf (#631)', ON_WINDOWS, () => {
  const { shell, gitRoot } = posixShell();
  const path = `${win32.join(gitRoot ?? assert.fail('no gitRoot on win32'), 'cmd')};${system32()}`;
  const out = execFileSync(shell, ['-c', 'command -v curl && command -v cat && printf %s found'], { env: withPath(path), encoding: 'utf8' });
  assert.match(out, /curl/);
  assert.match(out, /cat/);
  assert.ok(out.endsWith('found'), out);
});

test('on the Windows lane: a Windows path and /hooks/exit passed from sh.exe to node.exe arrive unchanged with posixShellEnv (#631)', ON_WINDOWS, () => {
  const windowsPath = 'C:\\Work\\my repo\\a.ts';
  const line = '"$HIVE_NODE" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" "$HIVE_WINDOWS_PATH" /hooks/exit';
  const env = { ...process.env, ...posixShellEnv('win32'), HIVE_NODE: process.execPath, HIVE_WINDOWS_PATH: windowsPath };
  assert.deepEqual(JSON.parse(execFileSync(posixShell().shell, ['-c', line], { env, encoding: 'utf8' })), [windowsPath, '/hooks/exit']);
});
