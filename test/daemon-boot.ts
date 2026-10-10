import type { TestContext } from 'node:test';
import { DaemonBootError, ensureDaemon, type StartedDaemon } from '../src/daemon.js';

// No daemon survives its test, whatever assertion failed. SIGTERM: a boot still in progress takes it as a stop (#786).
export function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** ensureDaemon, with the kill of the child it spawned registered on `t` as soon as its pid is known: from the resolved value, or from the
 *  DaemonBootError of a boot that did not answer, whose child may still be running (#786). Resolves or rethrows unchanged. tempDir removes
 *  the home only after every hook registered during the test, so the child is killed before its home goes. */
export async function bootTracked(t: TestContext, home: string, locale?: string): Promise<StartedDaemon> {
  try {
    const started = await ensureDaemon(home, locale);
    t.after(() => killQuietly(started.pid));
    return started;
  } catch (err) {
    if (err instanceof DaemonBootError) {
      const { pid } = err;
      t.after(() => killQuietly(pid));
    }
    throw err;
  }
}
