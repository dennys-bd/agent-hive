import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { type DaemonAddress, ourDaemon, stopDaemon } from '../../src/daemon.js';
import { buildEnv, cleanEnv } from '../../src/benchmark/exec.js';

export const DAEMON_OUT = 'daemon.out'; // run.js's stdout/stderr: a boot failure prints there before hive.log exists
const BOOT_WAIT_MS = 60_000;
const BOOT_POLL_MS = 500;

export interface ChildLike { pid?: number; exitCode: number | null; kill(signal?: NodeJS.Signals): boolean }
export type SpawnDaemon = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; out: number }) => ChildLike;
export interface DaemonDeps {
  spawn?: SpawnDaemon; address?: (home: string) => Promise<DaemonAddress | undefined>; stop?: (home: string) => Promise<boolean>; sleep?: (ms: number) => Promise<void>; waitMs?: number;
  /** run.js is the run branch's build, the evaluation's: it boots with the toolchain env only, as its install, build and test do. */
  isWorkerCode?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}
export interface RunningDaemon { home: string; address: DaemonAddress; child: ChildLike }

const spawnNode: SpawnDaemon = (file, args, { env, out }) => spawn(file, args, { env, stdio: ['ignore', out, out] });
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The run daemon is the harness's own build and spawns claude workers, which need the user's login. A headless Hive boots on
// HIVE_HOME, PATH, HOME and SHELL alone (src/run.ts, src/home.ts): the evaluated one gets no more than that and the toolchain
const daemonEnv = (home: string, deps: DaemonDeps): NodeJS.ProcessEnv => {
  const base = deps.baseEnv ?? process.env;
  return deps.isWorkerCode === true ? { ...buildEnv(base), HIVE_HOME: home } : cleanEnv(base, { HIVE_HOME: home });
};

function spawnWithOut(home: string, runJs: string, deps: DaemonDeps): ChildLike {
  const out = openSync(join(home, DAEMON_OUT), 'a', 0o600);
  try {
    return (deps.spawn ?? spawnNode)(process.execPath, [runJs], { env: daemonEnv(home, deps), out });
  } finally {
    closeSync(out); // spawn dup'ed it into the child
  }
}

/** `node <runJs>` on `home`, headless. The config has no port, so the daemon binds a free one and records it in this home's hive.port (#466):
 *  the two daemons of a pair never share a port. Up once this home's port and secret answer as this home. */
export async function bootDaemon(home: string, runJs: string, deps: DaemonDeps = {}): Promise<RunningDaemon> {
  const child = spawnWithOut(home, runJs, deps);
  const waitMs = deps.waitMs ?? BOOT_WAIT_MS;
  for (let waited = 0; waited < waitMs; waited += BOOT_POLL_MS) {
    if (child.exitCode !== null) throw new Error(`the daemon exited with ${child.exitCode} (see ${join(home, DAEMON_OUT)})`);
    const address = await (deps.address ?? ourDaemon)(home);
    if (address) return { home, address, child };
    await (deps.sleep ?? realSleep)(BOOT_POLL_MS);
  }
  child.kill('SIGTERM');
  throw new Error(`the daemon did not answer in ${waitMs / 1000} s (see ${join(home, DAEMON_OUT)})`);
}

export async function stopRunDaemon(daemon: RunningDaemon, deps: Pick<DaemonDeps, 'stop'> = {}): Promise<void> {
  try {
    await (deps.stop ?? stopDaemon)(daemon.home);
  } catch {
    daemon.child.kill('SIGTERM'); // run.ts handles SIGTERM as a stop
  }
}
