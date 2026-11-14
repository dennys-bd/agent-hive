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
// #800: the command shim is a POSIX sh script; Windows brings its own in node 5 of #704
export const NO_POSIX_SHELL: string | false = process.platform === 'win32' && 'win32 runs no POSIX command shim: node 5 of #704 brings its own';
// #806: Git's bin\sh.exe is a launcher, so the shim runs in its child: the Windows pid it sends is that child's, never the one Node started
export const SH_LAUNCHER: string | false = process.platform === 'win32' && 'Git\'s bin\\sh.exe is a launcher: the shim\'s Windows pid is its child\'s, not the pid Node started';
