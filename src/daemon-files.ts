// The daemon's files in its home: hive.port, the port it bound (every client reads it; the next boot tries it first); hive.lock, its pid,
// under an OS lock a helper process holds for the daemon's lifetime (one daemon per home, #466, #479); and hive.secret, this boot's secret
// (#467). Plain Node: the launcher (daemon.ts) shares it with the daemon (hive.ts, run.ts) and must not pull Express in.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

export const PORT_FILE = 'hive.port';
export const LOCK_FILE = 'hive.lock';
export const SECRET_FILE = 'hive.secret';
/** The launcher's boot wait, and how long a lock whose daemon has not bound yet counts as live: resolveSources runs gh before listen. */
export const WAIT_MS = 30_000;
const FILE_MODE = 0o600; // the home is this user's only
const PORT_MAX = 65_535;
const DECIMAL = /^\d+$/;
// The header line itself, newSecret's 32 bytes as hex (#467): curl sends it with -H @hive.secret, so the value never reaches an argv
const SECRET_LINE = /^x-hive-secret: ([0-9a-f]{64})$/;

// What both lock tools exit with when another process holds the lock (EX_TEMPFAIL): -E makes flock(1) match lockf(1) (#479)
const LOCK_HELD = 75;

/** The lock helper's argv on this platform (#479): it takes a BSD flock on `lock` without waiting, then runs cat, which only blocks on the
 *  daemon's pipe. -k keeps the file: lockf would unlink it on exit, and a later launch could then lock a new inode while an older one still
 *  holds the old. darwin's paths are absolute because a Hive opened from Finder has a bare PATH. */
export function lockHelper(platform: NodeJS.Platform, lock: string): [string, string[]] {
  if (platform === 'darwin') return ['/usr/bin/lockf', ['-k', '-s', '-t', '0', lock, '/bin/cat']];
  if (platform === 'linux') return ['flock', ['-n', '-E', String(LOCK_HELD), lock, 'cat']];
  throw new Error(`Agent Hive não executa em ${platform}: o lock da home precisa de lockf (macOS) ou flock (Linux)`);
}

// A file's text, trimmed; undefined when it is missing or unreadable
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined; // missing is the common case: no daemon ever ran in this home
  }
}

// The decimal a file holds; undefined when it is missing, unreadable or holds anything else
function readDecimal(path: string): number | undefined {
  const text = readText(path);
  return text !== undefined && DECIMAL.test(text) ? Number(text) : undefined;
}

// Through a temp file and a rename, so a reader never sees half a value. The temp file is removed, then created exclusively with 0600: wx
// never follows a symlink planted at the temp path of a home others can write to, and the mode is set at creation, so no reader ever sees
// a wider one. view-store.ts writes view-state.json with it too (#484).
export function writeAtomically(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { flag: 'wx', mode: FILE_MODE });
  renameSync(tmp, path);
}

/** The port the home's daemon last bound; undefined without the file or with one that names no port. No file = no daemon. */
export function readDaemonPort(home: string): number | undefined {
  const port = readDecimal(join(home, PORT_FILE));
  return port !== undefined && port > 0 && port <= PORT_MAX ? port : undefined;
}

/** Records the bound port through a temp file and a rename, so a reader never sees half a number. */
export function writeDaemonPort(home: string, port: number): void {
  writeAtomically(join(home, PORT_FILE), `${port}\n`);
}

/** The pid hive.lock names; undefined without a lock or with one that names no pid. */
export function readLockPid(home: string): number | undefined {
  const pid = readDecimal(join(home, LOCK_FILE));
  return pid !== undefined && pid > 0 ? pid : undefined;
}

/** This boot's secret, bare, from the header line hive.secret holds (#467); undefined without the file or with anything but that line of
 *  64 hex characters. No secret = no daemon, like a missing hive.port. */
export function readDaemonSecret(home: string): string | undefined {
  return SECRET_LINE.exec(readText(join(home, SECRET_FILE)) ?? '')?.[1];
}

/** Records this boot's secret as the header line curl reads with -H @file, 0600 from its creation (#467). */
export function writeDaemonSecret(home: string, secret: string): void {
  writeAtomically(join(home, SECRET_FILE), `x-hive-secret: ${secret}\n`);
}

/** Removes hive.secret while hive.lock names this process (#467). Runs before releaseLock: once the lock is free, the next daemon writes its
 *  pid and its own secret (#479). */
export function removeDaemonSecret(home: string): void {
  if (readLockPid(home) === process.pid) rmSync(join(home, SECRET_FILE), { force: true });
}

/** Whether a process holds this pid: signal 0 checks without sending anything; EPERM is another user's process, alive all the same. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// How long ago the lock was last written; one that vanished meanwhile reads as old. Clamped at 0: under load the filesystem's clock can
// read a hair ahead of Date.now(), which would otherwise read a lock just written as negative age instead of a young one.
function lockAge(path: string): number {
  try {
    return Math.max(0, Date.now() - statSync(path).mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

type LockHelper = ChildProcessByStdio<Writable, Readable, null>;

// The helper holding each home this process locked, and the exit of each one it released: the lock is free only once that exit happened (#479)
const helpers = new Map<string, LockHelper>();
const released = new Map<string, Promise<void>>();

const alreadyRunning = (home: string): Error => new Error(`Agent Hive já está em execução nesta home (pid ${readLockPid(home) ?? '?'})`);

// Created here, not by the helper: exclusive and 0600 from its creation, and refused unless it is a plain file, so a symlink planted at the
// path is never followed (#466). Never removed, for the reason lockHelper passes -k (#479).
function ensureLockFile(lock: string): void {
  try {
    writeFileSync(lock, '', { flag: 'wx', mode: FILE_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (!lstatSync(lock).isFile()) throw new Error(`${lock} não é um arquivo comum`);
}

// In place: the helper holds the lock on this inode, and a rename would swap it for another. O_NOFOLLOW refuses a symlink put at the path
// since ensureLockFile's check instead of writing through it (#479).
function writeLockPid(lock: string): void {
  const fd = openSync(lock, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    writeFileSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
}

// One byte to the helper's stdin: cat runs only once the lock is held, so the byte coming back means taken, and an exit first means
// refused. This process holds the only write end of its stdin (Node's pipes are close-on-exec, so no worker inherits it): however the
// daemon exits, cat reads EOF and the kernel drops the lock. Detached, so a terminal's Ctrl-C reaches the daemon and not the helper, which
// would otherwise let go while close() still kills the workers. stderr is ignored so the helper never holds hive.log, or a test runner's
// pipe, open (#479).
function spawnHelper(home: string, lock: string, onLost: (status: string) => void): Promise<LockHelper> {
  const [tool, args] = lockHelper(process.platform, lock);
  const child = spawn(tool, args, { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`Agent Hive não pegou ${lock}: ${err.message}`)));
    child.stdin.on('error', () => undefined); // EPIPE when the helper exits first: its exit says why
    let exited = false;
    child.once('exit', (code, signal) => {
      exited = true;
      child.stdin.destroy(); // a cat left behind by a killed lockf may still hold the lock through its fd, taken or not: the EOF ends it
      const status = String(code ?? signal);
      if (helpers.get(home) !== child) {
        // not taken (after a release, the promise has resolved long ago and this is a no-op)
        reject(code === LOCK_HELD ? alreadyRunning(home) : new Error(`Agent Hive não pegou ${lock}: ${tool} saiu com ${status}`));
        return;
      }
      helpers.delete(home);
      onLost(status);
    });
    child.stdout.once('data', () => {
      if (exited) return; // 'exit' is not ordered after pending stdout: a helper dead before its echo was read holds nothing
      helpers.set(home, child);
      resolve(child);
    });
    child.stdin.write('\n');
  });
}

/** Takes hive.lock for this process through the lock helper, then writes this pid into it (#466, #479). Refused while another process, or
 *  another call in this one, holds it. Once taken, the helper exiting (someone killed it) is reported through `onLost` with its status. */
export async function acquireLock(home: string, onLost: (status: string) => void): Promise<void> {
  const lock = join(home, LOCK_FILE);
  await released.get(home); // this process released the home: free only once that helper exited
  ensureLockFile(lock);
  const child = await spawnHelper(home, lock, onLost);
  try {
    writeLockPid(lock);
  } catch (err) {
    releaseLock(home);
    throw err;
  }
  // Held for the daemon's lifetime, but never the reason its event loop stays alive; ref'd until now so an await on the echo could not end early
  child.unref();
  (child.stdin as Socket).unref();
  (child.stdout as Socket).unref();
}

/** How long ago hive.lock was last written; infinite without one. */
export const lockAgeMs = (home: string): number => lockAge(join(home, LOCK_FILE));

/** Lets go of this process's lock on the home: ends the helper's stdin, so cat exits and the kernel drops the lock. hive.lock keeps its pid.
 *  Does nothing for a home this process does not hold (#479). */
export function releaseLock(home: string): void {
  const child = helpers.get(home);
  if (child === undefined) return;
  helpers.delete(home);
  child.ref(); // until it exits: the next acquireLock of this home awaits that, and an empty event loop would end the wait early
  released.set(home, once(child, 'exit').then(() => undefined, () => undefined));
  child.stdin.end();
}
