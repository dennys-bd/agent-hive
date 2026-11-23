// The local machine's disk, exec and facts (#941): out of machine-local.ts, whose pty half reaches node's native pty module, so the distro's
// helper (src/wsl/helper-main.ts) builds its machine from this file and bundles nothing but node: imports under it.
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { envValue } from './exec-path.js';
import { type Machine, type MachineExec, type MachineInfo, pathsOf, toMachineError } from './machine.js';
import { localFs } from './machine-local-fs.js';
import { posixShell } from './posix-shell.js';
import type { AgentAvailability, Exec } from './types.js';

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
export const LOCAL_DISK: Pick<Machine, 'exec' | 'fs' | 'paths'> = { ...localDisk(promisify(execFile)), paths: pathsOf(process.platform) };

/** The facts of the machine this process runs on (#158): the local machine's info() and the distro's helper's hello (#941).
 *  #806: win32's env names ignore case; elsewhere PATH is PATH. */
export function infoOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, agents: readonly AgentAvailability[]): MachineInfo {
  const path = (platform === 'win32' ? envValue(env, 'PATH') : env.PATH) ?? '';
  const { CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_HOME: codexHome, COPILOT_HOME: copilotHome } = env;
  return {
    platform, arch: process.arch, homedir: homedir(), tmpdir: tmpdir(), path, shell: posixShell().shell,
    ...(claudeConfigDir === undefined ? {} : { claudeConfigDir }), ...(codexHome === undefined ? {} : { codexHome }),
    ...(copilotHome === undefined ? {} : { copilotHome }), agents: [...agents],
  };
}
