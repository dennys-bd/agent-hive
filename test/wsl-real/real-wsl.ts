// The real distro of the WSL lane (#948): its name, the machine over the server's own wsl.exe dependencies, and what every test of the lane
// reads back through that machine. Never through \\wsl$, which is no path of the machine (#869's spike, section 1).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { type ExecOptions, type Machine, MachineError, type RunSpec } from '../../src/machine.js';
import { createPtyHost } from '../../src/pty-host.js';
import { nodePtySpawn } from '../../src/pty-spawn.js';
import { helperBundle } from '../../src/wsl/helper-install.js';
import { createWslMachine, type WslMachine, type WslMachineDeps } from '../../src/wsl/wsl-machine.js';
import { fakeMachine } from '../fake-machine.js';
import { SECRET } from '../secret-client.js';

const execFileBuffer = promisify(execFile); // as src/server.ts: wsl.exe's own messages are UTF-16LE, so its output is read as Buffers
const POLL_MS = 250;
export const CLOSED_PORT = 1; // nothing listens there: the relay's answer is a refusal, which only the relay test changes
const WSL_FOLDER = ['.config', 'agent-hive', 'wsl']; // the distro's Hive folder (#943): hooks.json, hive.secret, relay-port, prompts/

function laneDistro(): string {
  const name = process.env.HIVE_WSL_DISTRO ?? '';
  if (name === '') throw new Error('HIVE_WSL_DISTRO is empty: the lane runs through scripts/test-wsl.mjs');
  return name;
}

/** The distro the lane runs against: only HIVE_WSL_DISTRO names it (#948 decision 7). */
export const DISTRO = laneDistro();

export interface RealWsl {
  machine: WslMachine;
  freshDir(): Promise<string>; // a new folder under the distro user's home, removed after the test
  removeAfter(path: string): void; // a path the test made elsewhere in the distro, removed after it
}

// The process dependencies are the server's own (src/server.ts); the rest is what a machine that runs no agent needs. The host only reads
// the helper bundle and the command shim's template, so the local machine over a fake exec is enough
function laneDeps(t: TestContext, hivePort: () => number): WslMachineDeps {
  return {
    command: ['wsl.exe'], run: (file, args, opts) => execFileBuffer(file, args, opts), spawn: (file, args, opts) => spawn(file, args, opts),
    env: process.env, helperFile: helperBundle(), node: 'node', hivePort, secret: SECRET, shimWords: () => [], language: () => 'en',
    plugins: { dir: () => assert.fail('the lane machine runs no agent') }, host: fakeMachine(), ptys: createPtyHost(nodePtySpawn),
    hostCwd: tmpdir(), lend: async () => { throw new Error('no GitHub login on the lane'); }, log: (line) => t.diagnostic(line),
  };
}

export const stdoutOf = async (machine: Machine, file: string, args: string[], opts?: ExecOptions): Promise<string> =>
  (await machine.exec(file, args, opts)).stdout;

/** The distro user's home: info() answers only after a call has waited for the helper's hello. */
export async function homeOf(machine: Machine): Promise<string> {
  await machine.exec('true', []);
  return machine.info().homedir;
}

export const hiveFolderOf = async (machine: Machine): Promise<string> => machine.paths.join(await homeOf(machine), ...WSL_FOLDER);

const HELPER_PATTERN = '/.config/agent-hive/wsl/helper-'; // every helper's argv: node <folder>/helper-<hash>.mjs <folder>
const REAP_MS = 5_000;
const NONE_MATCHED = 1; // pgrep's and pkill's exit when no process matches

// The helpers still running in the distro, one `pid argv` per line; none is '', which pgrep answers with its exit 1
async function helpersLeft(): Promise<string> {
  try {
    return (await execFileBuffer('wsl.exe', ['-d', DISTRO, '--exec', 'pgrep', '-af', '--', HELPER_PATTERN])).stdout.trim();
  } catch (err) {
    if ((err as { code?: unknown }).code === NONE_MATCHED) return '';
    throw err;
  }
}

// A closed machine's helper ends when its stdin does. WSL 1 kept one running past close() once, still holding the relay port of the
// next test file with its own Hive's port, so a leftover is named in the log and killed: each file starts from a distro with none
async function reapHelpers(t: TestContext): Promise<void> {
  const deadline = Date.now() + REAP_MS;
  let left = await helpersLeft();
  while (left !== '' && Date.now() < deadline) {
    await sleep(POLL_MS);
    left = await helpersLeft();
  }
  if (left === '') return;
  t.diagnostic(`helper still running ${REAP_MS} ms after close():\n${left}`);
  await execFileBuffer('wsl.exe', ['-d', DISTRO, '--exec', 'pkill', '-f', '--', HELPER_PATTERN]).catch((err: unknown) => {
    if ((err as { code?: unknown }).code !== NONE_MATCHED) throw err;
  });
}

/** The real machine of the lane's distro (#948 decision 9), closed after the test. */
export function realWsl(t: TestContext, { hivePort = () => CLOSED_PORT }: { hivePort?: () => number } = {}): RealWsl {
  const machine = createWslMachine(DISTRO, laneDeps(t, hivePort));
  const made: string[] = [];
  // queued behind every hook the test registers later (a server's close above all), as tempDir's removal is: the machine goes last
  t.after(async () => {
    t.after(async () => {
      for (const path of made) await machine.fs.rm(path, { recursive: true, force: true }).catch((err: unknown) => t.diagnostic(`rm ${path}: ${String(err)}`));
      machine.close();
      await reapHelpers(t);
    });
  });
  return {
    machine,
    freshDir: async () => {
      const dir = (await stdoutOf(machine, 'mktemp', ['-d', machine.paths.join(await homeOf(machine), 'hive-948-XXXXXX')])).trim();
      made.push(dir);
      return dir;
    },
    removeAfter: (path) => { made.push(path); },
  };
}

/** Polls `check` until it holds; past `ms` the test fails naming `what`, with `explain()`'s text for the job's log. */
export async function within(ms: number, check: () => Promise<boolean>, what: string, explain: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`${what}: not within ${ms} ms\n${explain()}`);
    await sleep(POLL_MS);
  }
}

const PGREP_NONE = 1; // pgrep's exit when nothing matched

/** Whether a process inside the distro has `marker` in its command line. pgrep runs as the helper's own child, never through a shell, so
 *  it matches neither itself nor a wrapper. */
export async function isRunning(machine: Machine, marker: string): Promise<boolean> {
  try {
    await machine.exec('pgrep', ['-f', '--', marker]);
    return true;
  } catch (err) {
    if (err instanceof MachineError && err.code === PGREP_NONE) return false;
    throw err;
  }
}

/** A terminal of the lane running `command` through the distro's shell, `env` laid over the run's. */
export const shellSpec = (ptyId: string, cwd: string, command: string, env: Record<string, string> = {}): RunSpec =>
  ({ ptyId, slug: 'hive-948', workspace: 'lane', cwd, terminal: true, run: { command, env } });

export interface PtyRun { output(): string; code(): number | undefined; kill(): Promise<void> }

/** The run started and subscribed: what it printed so far, its exit code once it ended, and its kill, which also runs after the test. */
export async function openPty(t: TestContext, machine: Machine, spec: RunSpec): Promise<PtyRun> {
  const handle = machine.pty.spawn(spec, { onExit: () => undefined, onError: (message) => t.diagnostic(`pty ${spec.ptyId}: ${message}`) });
  t.after(() => handle.kill());
  await handle.started;
  let output = '';
  let exitCode: number | undefined;
  const off = machine.pty.subscribe(spec.ptyId, (data) => { output += data; }, (code) => { exitCode = code; });
  assert.ok(off !== undefined, `pty ${spec.ptyId} ended before it was heard`);
  return { output: () => output, code: () => exitCode, kill: () => handle.kill() };
}
