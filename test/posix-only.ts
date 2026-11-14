import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';

// The design keeps the modes in the code and lets the profile protect the home ("Files: modes stay, the profile protects")
export const NO_POSIX_MODES: string | false = process.platform === 'win32' && 'win32 has no POSIX mode bits: stat().mode & 0o777 is always 0o666';
// The code paths these tests cover are platform-neutral; only the way they make the call fail is POSIX (#655 decision 5)
export const NO_POSIX_FAULTS: string | false = process.platform === 'win32' && 'win32 ignores chmod for the file\'s owner and has no mkfifo: the call meant to fail succeeds there';

const MODE_BITS = 0o777;

/** The mode check as a subtest skipped on win32: the caller's other assertions still run there. Await it before the file can change. */
export async function assertMode(t: TestContext, path: string, mode: number, message?: string): Promise<void> {
  await t.test(`mode 0${mode.toString(8)}${message === undefined ? '' : ` (${message})`}`, { skip: NO_POSIX_MODES }, async () => {
    assert.equal((await stat(path)).mode & MODE_BITS, mode, message);
  });
}
// #806: Node's kill on win32 is TerminateProcess, and a console Ctrl-C reaches Git's sh.exe launcher too: no trap of the shim's sees either
export const NO_POSIX_SIGNALS: string | false = process.platform === 'win32' && 'win32 sends no POSIX signal: Node\'s kill is TerminateProcess, which no trap of the shim\'s sees';
// #806 decision 15: whether stty works under sh.exe in a ConPTY is the lane's own question, checked either way in command-shim-win32.test.ts
export const NO_POSIX_TTY: string | false = process.platform === 'win32' && 'a ConPTY may refuse sh.exe\'s stty: command-shim-win32.test.ts checks the wait\'s key there either way';
// #806: Git's bin\sh.exe is a launcher, so the shim runs in its child: the Windows pid it sends is that child's, never the one Node started
export const SH_LAUNCHER: string | false = process.platform === 'win32' && 'Git\'s bin\\sh.exe is a launcher: the shim\'s Windows pid is its child\'s, not the pid Node started';
// #806 decision 15: the feasibility tests need Git's bash, PowerShell and a ConPTY, which only the Windows lane has
export const ONLY_WIN32: string | false = process.platform !== 'win32' && 'Windows only: Git\'s bash, PowerShell and a ConPTY run on the Windows lane (#806)';
