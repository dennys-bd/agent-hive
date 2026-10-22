// Two Hives on one experiment (#472): <experiment>/run.lock holds the running Hive's pid. A lock whose pid is not alive is taken over, so a
// crash needs no manual cleanup; the loop's end removes it.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pidExists } from '../daemon-files.js';

export const LOCK_FILE = 'run.lock';
export interface LockDeps { pid?: number; alive?(pid: number): boolean }

async function create(path: string, pid: number): Promise<boolean> {
  try {
    await writeFile(path, `${pid}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export async function takeLock(dir: string, deps: LockDeps = {}): Promise<boolean> {
  const path = join(dir, LOCK_FILE);
  const pid = deps.pid ?? process.pid;
  if (await create(path, pid)) return true;
  const held = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
  if (Number.isInteger(held) && held > 0 && (deps.alive ?? pidExists)(held)) return false;
  await rm(path, { force: true });
  return create(path, pid); // a second Hive taking a dead lock over at the same instant gets false here
}

export const releaseLock = (dir: string): Promise<void> => rm(join(dir, LOCK_FILE), { force: true });
