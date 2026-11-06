// A tree's kill (#637): a timeout, an output cap or a stop on a formatter, a checker or a worktree RUN step must reach what the process
// started, not only the process. Off win32 that is the process group `detached` gave the child; win32 has no process group, so taskkill /T
// walks the parent tree instead, and the spawn stays out of `detached` there (see treeSpawnOptions).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Exec } from './types.js';

const execFileAsync = promisify(execFile);
// taskkill is a console program: hidden, or every kill from the detached daemon flashes a window
const TASKKILL_CAP_MS = 10_000; // a hung taskkill must not hold its handle open forever
const hiddenExec: Exec = (file, args) => execFileAsync(file, args, { windowsHide: true, timeout: TASKKILL_CAP_MS });

export interface TreeSpawnOptions { detached: boolean; windowsHide: true }

/** A killable tree's spawn options. Off win32, a process group of its own. On win32 not detached: DETACHED_PROCESS drops the console and
 *  Windows then ignores CREATE_NO_WINDOW, so every console grandchild (pnpm, node, git) would open a window. windowsHide gives the child a
 *  hidden console its children inherit, and staying in libuv's job means the run dies with the daemon. */
export const treeSpawnOptions = (platform: NodeJS.Platform): TreeSpawnOptions => ({ detached: platform !== 'win32', windowsHide: true });

/** Kills `pid` and what it started. Never rejects: the callers fire it and settle at once (`void killTree(...)`), and a tree already gone
 *  is the common case after a race with the exit. Known limit on win32: a grandchild whose parent already exited is not found. */
export async function killTree(pid: number | undefined, platform: NodeJS.Platform, exec: Exec = hiddenExec): Promise<void> {
  // undefined: the spawn never started. Anything but a positive integer would make -pid our own group (0) or nonsense: the single kill point refuses it
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    try {
      await exec('taskkill', ['/T', '/F', '/PID', String(pid)]);
    } catch {
      // exit 128: already gone; any other failure leaves nothing more to try
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: the group already exited
  }
}
