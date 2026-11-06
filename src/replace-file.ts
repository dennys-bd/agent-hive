// A temp file renamed over its target (#629). On Windows the rename fails with EPERM, EBUSY or EACCES while another process (a reader, an
// antivirus, the search indexer) holds the target open without delete sharing; those locks last tens to hundreds of ms, so win32 retries
// for about 1.3 s. On POSIX the same codes are a real permission problem a retry cannot fix: thrown at once.
import { renameSync as fsRenameSync } from 'node:fs';
import { rename as fsRename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const RETRIED_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** The waits between the 8 tries; the sync path blocks the event loop for at most their sum. */
export const RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640];

export interface ReplaceDeps { platform?: NodeJS.Platform; rename?(from: string, to: string): Promise<void>; sleep?(ms: number): Promise<void> }
export interface ReplaceSyncDeps { platform?: NodeJS.Platform; renameSync?(from: string, to: string): void; sleepSync?(ms: number): void }

function isRetried(err: unknown, platform: NodeJS.Platform): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return platform === 'win32' && typeof code === 'string' && RETRIED_CODES.has(code);
}

// Sleeps without burning CPU: nothing ever notifies the slot, so the wait always runs to its timeout
const blockFor = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Renames tmp over target; on win32 a lock error is retried, and the last error is thrown unchanged with tmp left in place. */
export async function replaceFile(tmp: string, target: string, deps: ReplaceDeps = {}): Promise<void> {
  const { platform = process.platform, rename = fsRename, sleep = (ms: number) => delay(ms) } = deps;
  for (const wait of RETRY_DELAYS_MS) {
    try {
      return await rename(tmp, target);
    } catch (err) {
      if (!isRetried(err, platform)) throw err;
      await sleep(wait);
    }
  }
  return rename(tmp, target);
}

/** replaceFile for writeAtomically, which is synchronous. */
export function replaceFileSync(tmp: string, target: string, deps: ReplaceSyncDeps = {}): void {
  const { platform = process.platform, renameSync = fsRenameSync, sleepSync = blockFor } = deps;
  for (const wait of RETRY_DELAYS_MS) {
    try {
      renameSync(tmp, target);
      return;
    } catch (err) {
      if (!isRetried(err, platform)) throw err;
      sleepSync(wait);
    }
  }
  renameSync(tmp, target);
}
