// The local machine (#158): the host's own disk, processes and ptys behind Machine, so 7.2 to 7.4 move every caller onto it and node 8's
// remote machine stands in for an actor's task with no caller changing again. The pty half is machine-local-pty.ts.
import { execFile, spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { envValue } from './exec-path.js';
import { type Machine, type MachineChild, MachineError, type MachineExec, type MachineInfo, type Machines, type ProcessOptions } from './machine.js';
import { createLocalPty, type LocalPtyDeps } from './machine-local-pty.js';
import { localFs } from './machine-local-fs.js';
import { runDetached } from './machine-run.js';
import { posixShell } from './posix-shell.js';
import type { AgentAvailability, Exec, MachineId } from './types.js';

export interface LocalMachineDeps extends Omit<LocalPtyDeps, 'env' | 'platform'> {
  exec: Exec; // the server's own: tests see every call, as today
  agents: readonly AgentAvailability[]; // what boot detected (#516); 7.4 detects per machine
  env?: NodeJS.ProcessEnv; // process.env unless a test injects one
  platform?: NodeJS.Platform; // process.platform unless a test injects one
}

const LOCAL: MachineId = 'local';

const text = (value: unknown): string => (typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '');

/** execFile's rejection (or a test fake's) as a MachineError, field for field, the original as its cause. */
export function toMachineError(err: unknown): MachineError {
  if (err instanceof MachineError) return err;
  const fields: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
  const { code } = fields;
  return new MachineError(err instanceof Error ? err.message : String(err), {
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    stderr: text(fields.stderr), stdout: text(fields.stdout), killed: fields.killed === true,
  }, { cause: err });
}

// stdio left at its default, three pipes: spawn's type is then ChildProcessWithoutNullStreams
const localProcess = (command: string, args: string[], { cwd, env, windowsVerbatimArguments }: ProcessOptions): MachineChild =>
  spawn(command, args, { cwd, env, windowsVerbatimArguments });

// cwd and signal ride along to the exec under it: execFile takes both, and a test's fake sees them
const machineExec = (exec: Exec): MachineExec => async (file, args, opts) => {
  try {
    return await exec(file, args, opts);
  } catch (err) {
    throw toMachineError(err);
  }
};

/** The local disk with an exec over it (#159): what createLocalMachine is built on, and what a host caller with no server yet hands a
 * function that reads a workspace folder. */
export const localDisk = (exec: Exec): Pick<Machine, 'exec' | 'fs'> => ({ fs: localFs, exec: machineExec(exec) });

/** workspacePathProblem's own (#202): always the real git, never an injected one, as it was before the machine. */
export const LOCAL_DISK: Pick<Machine, 'exec' | 'fs'> = localDisk(promisify(execFile));

// #806: win32's env names ignore case; elsewhere PATH is PATH
function infoOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, agents: readonly AgentAvailability[]): MachineInfo {
  const path = (platform === 'win32' ? envValue(env, 'PATH') : env.PATH) ?? '';
  const { CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_HOME: codexHome, COPILOT_HOME: copilotHome } = env;
  return {
    platform, arch: process.arch, homedir: homedir(), tmpdir: tmpdir(), path, shell: posixShell().shell,
    ...(claudeConfigDir === undefined ? {} : { claudeConfigDir }), ...(codexHome === undefined ? {} : { codexHome }),
    ...(copilotHome === undefined ? {} : { copilotHome }), agents: [...agents],
  };
}

export function createLocalMachine(deps: LocalMachineDeps): Machine {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  let read: MachineInfo | undefined; // nothing it holds changes while the Hive runs
  return {
    id: LOCAL, ...localDisk(deps.exec), run: runDetached, process: localProcess,
    pty: createLocalPty({ ...deps, env, platform }),
    info: () => {
      read ??= infoOf(env, platform, deps.agents);
      return read;
    },
  };
}

/** Until node 8 the local machine is every activity's, an id it does not know included. */
export function createLocalMachines(deps: LocalMachineDeps): Machines {
  const local = createLocalMachine(deps);
  return { local, for: () => local };
}
