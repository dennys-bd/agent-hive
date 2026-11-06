// The POSIX shell every shell line of the Hive runs through (#631): the pty's launch line, a worktree RUN step, a custom formatter's line.
// /bin/sh on macOS and Linux; on win32 Git for Windows' sh.exe, found from git --exec-path. The resolver takes the platform and its lookups,
// so node:test covers the win32 branch on every OS; posixShell() resolves once per process (the boot calls it first) and keeps the answer.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface PosixShell { shell: string; gitRoot?: string } // gitRoot on win32 only: 3.2 and 3.5 find usr\bin's unzip and tar under it
export interface ShellLookups {
  gitExecPath(): string | undefined; // `git --exec-path`, trimmed; undefined when git is missing or fails
  exists(path: string): boolean;
}

const POSIX_SH = '/bin/sh';
const NO_GIT = 'Agent Hive needs Git for Windows (git and its sh.exe) on PATH: https://gitforwindows.org';
// bin\sh.exe first: Git's launcher puts usr\bin and mingw64\bin on PATH, so curl, cat and printf are found with PATH at Git\cmd alone.
// usr\bin\sh.exe covers a MinGit or portable layout that has no launcher
const SH_PLACES = [['bin', 'sh.exe'], ['usr', 'bin', 'sh.exe']];

/** The POSIX shell of `platform`. win32: Git's root is three levels above its exec path (<root>\<mingw64|ucrt64|clangarm64>\libexec\git-core);
 *  no git or no sh.exe throws one line naming Git for Windows, which the boot ends with. */
export function resolvePosixShell(platform: NodeJS.Platform, lookups: ShellLookups): PosixShell {
  if (platform !== 'win32') return { shell: POSIX_SH };
  const execPath = lookups.gitExecPath();
  if (!execPath) throw new Error(NO_GIT);
  const gitRoot = win32.join(execPath, '..', '..', '..'); // win32.join also turns git's forward slashes into backslashes
  const shell = SH_PLACES.map((parts) => win32.join(gitRoot, ...parts)).find((path) => lookups.exists(path));
  if (shell === undefined) throw new Error(NO_GIT);
  return { shell, gitRoot };
}

const REAL_LOOKUPS: ShellLookups = {
  gitExecPath: () => {
    try {
      return execFileSync('git', ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || undefined;
    } catch {
      return undefined; // no git on PATH, or one that fails: the boot's one line says what to install
    }
  },
  exists: existsSync,
};

let resolved: PosixShell | undefined;

/** This process's POSIX shell, resolved on the first call and kept. A throw is not kept: nothing runs without a shell, and the boot stops on it. */
export function posixShell(): PosixShell {
  resolved ??= resolvePosixShell(process.platform, REAL_LOOKUPS);
  return resolved;
}

/** What every line run through sh.exe gets in its env on win32 (#631): MSYS would rewrite an argument that looks like a POSIX path
 *  (/hooks/exit) when sh.exe starts a native .exe, and the Hive's own arguments must arrive as written. */
export const posixShellEnv = (platform: NodeJS.Platform): Record<string, string> => (platform === 'win32' ? { MSYS2_ARG_CONV_EXCL: '*' } : {});
