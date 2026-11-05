import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posixShellEnv, resolvePosixShell, type ShellLookups } from '../src/posix-shell.js';

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
