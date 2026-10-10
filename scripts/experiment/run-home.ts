import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILE } from '../../src/config.js';

export const STATE_FILE = 'state.json'; // state-store.ts keeps its name private
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A fresh home, as test-hive.ts's resetHome builds one: written before the daemon boots, never while it runs. 0700: it holds the secret. */
export async function writeHome(home: string, config: unknown, state: unknown): Promise<void> {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, CONFIG_FILE), json(config), { mode: 0o600 });
  await writeFile(join(home, STATE_FILE), json(state), { mode: 0o600 });
}

/** The state folder and the two under it, 0700: chmod too, since mkdir's mode is cut by the umask and skipped for a folder that exists. */
export async function prepareState(state: string): Promise<void> {
  for (const dir of [state, join(state, 'homes'), join(state, 'experiments')]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}
