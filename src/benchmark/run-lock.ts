// Two Hives on one experiment (#472): <experiment>/run.lock holds the running Hive's pid. A lock whose pid is not alive is taken over, so a
// crash needs no manual cleanup; the loop's end removes it.
import { randomBytes } from 'node:crypto';
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pidExists } from '../daemon-files.js';

export const LOCK_FILE = 'run.lock';
export interface LockDeps { pid?: number; alive?(pid: number): boolean }

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;
const uniqueName = (path: string, kind: string): string => `${path}.${kind}.${randomBytes(6).toString('hex')}`;

// The pid is written to a file of its own and linked into place: the lock never exists empty, so a reader never mistakes a half-written one
// for a stale one, and link() fails with EEXIST when the lock is there already
async function create(path: string, pid: number): Promise<boolean> {
  const temp = uniqueName(path, 'tmp');
  await writeFile(temp, `${pid}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await link(temp, path);
    return true;
  } catch (err) {
    if (codeOf(err) === 'EEXIST') return false;
    throw err;
  } finally {
    await rm(temp, { force: true });
  }
}

// Held unless the file names a pid that is not alive: an empty or unreadable file is a lock being written or a disk problem, not a dead Hive
async function isStale(path: string, alive: (pid: number) => boolean): Promise<string | undefined> {
  const text = await readFile(path, 'utf8');
  if (text.trim() === '') return undefined;
  const held = Number.parseInt(text, 10);
  return Number.isInteger(held) && held > 0 && alive(held) ? undefined : text;
}

// Renaming the stale lock aside first means only one Hive can take it over: the others find nothing to rename. If what was renamed is not
// what was judged stale (another Hive took over in between and this renamed its fresh lock), it is put back.
// ponytail: the put-back is best effort; a lock manager is the upgrade if two Hives ever contend this hard
async function takeOver(path: string, stale: string): Promise<boolean> {
  const aside = uniqueName(path, 'stale');
  try {
    await rename(path, aside);
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return false;
    throw err;
  }
  try {
    if ((await readFile(aside, 'utf8')) === stale) return true;
    await link(aside, path).catch(() => undefined);
    return false;
  } finally {
    await rm(aside, { force: true });
  }
}

/** true when this Hive holds the lock; false when another live Hive does. An I/O error rejects: it is not "another Hive is running". */
export async function takeLock(dir: string, deps: LockDeps = {}): Promise<boolean> {
  const path = join(dir, LOCK_FILE);
  const pid = deps.pid ?? process.pid;
  if (await create(path, pid)) return true;
  const stale = await isStale(path, deps.alive ?? pidExists).catch((err: unknown) => {
    if (codeOf(err) === 'ENOENT') return ''; // released between the two calls: free
    throw err;
  });
  if (stale === undefined) return false;
  if (stale !== '' && !(await takeOver(path, stale))) return false;
  return create(path, pid); // a second Hive taking a dead lock over at the same instant gets false here
}

export const releaseLock = (dir: string): Promise<void> => rm(join(dir, LOCK_FILE), { force: true });
