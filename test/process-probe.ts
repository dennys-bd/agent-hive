import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { killTree, treeSpawnOptions } from '../src/kill-tree.js';

const POLL_MS = 50;
const GONE_WITHIN_MS = 10_000; // taskkill and SIGKILL land asynchronously; the Windows runner is slow to tear a tree down

// A node child that starts a node grandchild in its own tree and prints the grandchild's pid; both idle until killed. node -e, not sh and
// sleep, so the same script runs on the Windows lane.
const PARENT = [
  "const { spawn } = require('node:child_process');",
  "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  'console.log(g.pid);',
  'setInterval(() => {}, 1000);',
].join(' ');

export interface Pair { child: ChildProcess; pid: number; grandchild: number }

/** Alive while signal 0 reaches it. EPERM: it exists, it is just not ours. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True once the pid is gone, false if it is still alive after withinMs: a short bounded poll, never an open-ended wait. */
export async function gone(pid: number, withinMs = GONE_WITHIN_MS): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/** The pair above. `argv` lands in the child's command line only (#638: a unique marker a pattern can match), never in the grandchild's. */
export async function childWithGrandchild(t: TestContext, argv: readonly string[] = []): Promise<Pair> {
  const child = spawn(process.execPath, ['-e', PARENT, ...argv], { stdio: ['ignore', 'pipe', 'ignore'], ...treeSpawnOptions(process.platform) });
  // a failed assertion must not leave the pair running; once the child exited, its pid may already be another process's
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await killTree(child.pid, process.platform);
  });
  const pid = child.pid ?? assert.fail('the child did not start');
  const [line] = (await once(createInterface({ input: child.stdout ?? assert.fail('no stdout') }), 'line')) as [string];
  const grandchild = Number(line);
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, line);
  return { child, pid, grandchild };
}
