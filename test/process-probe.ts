import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 50;
const GONE_WITHIN_MS = 10_000; // taskkill and SIGKILL land asynchronously; the Windows runner is slow to tear a tree down

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
