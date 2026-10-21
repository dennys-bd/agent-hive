import { join } from 'node:path';
import { privateDir } from '../../src/benchmark/run-home.js';

/** The state folder and the two under it, 0700. */
export async function prepareState(state: string): Promise<void> {
  for (const dir of [state, join(state, 'homes'), join(state, 'experiments')]) await privateDir(dir);
}
