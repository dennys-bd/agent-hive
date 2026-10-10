import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What registers the removal: a test's TestContext, or `{ after }` from node:test for a dir made at module level. */
export interface AfterHost {
  after(fn: () => Promise<void>): void;
}

/**
 * A fresh `hive-<prefix>XXXXXX` dir under os.tmpdir(), removed after the test whether it passed or failed (#428). The one place under test/
 * that makes a temp dir: a guard in temp-dir.test.ts fails on any other.
 */
export async function tempDir(t: AfterHost, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `hive-${prefix}`));
  // node:test runs after hooks in the order they were registered and re-reads the list as it goes. A server or daemon closed by a hook
  // registered after this one still writes into the dir while closing, so this hook only queues the removal behind all of them.
  t.after(async () => {
    t.after(() => rm(dir, { recursive: true, force: true }));
  });
  return dir;
}
