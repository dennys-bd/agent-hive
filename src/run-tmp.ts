import { tmpdir } from 'node:os';
import type { Machine } from './machine.js';

/** A run's own temp dir (#428): TMPDIR for everything the run starts, removed when it exits. Under the daemon's own temp dir, which the OS
 * purges, so the dir of a run a daemon crash interrupted still goes eventually. Its own module (#873): spawn.ts imports the runners'
 * registry, so a runner naming a folder in it (Copilot's instructions) would import the registry back before its own binding exists. */
export function runTmpDir(ptyId: string, paths: Machine['paths'], base = tmpdir()): string {
  return paths.join(base, 'hive-runs', ptyId);
}
