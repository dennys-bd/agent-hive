// The local machine (#158): the host's own disk, processes and ptys behind Machine, so 7.2 to 7.4 move every caller onto it and node 8's
// remote machine stands in for an actor's task with no caller changing again. The pty half is machine-local-pty.ts; the disk, its exec and
// the machine's facts are machine-local-disk.ts (#941), which the distro's helper takes without the pty.
import { spawn } from 'node:child_process';
import { type Machine, type MachineChild, type MachineInfo, type ProcessOptions, pathsOf } from './machine.js';
import { infoOf, localDisk } from './machine-local-disk.js';
import { localWatch } from './machine-local-fs.js';
import { createLocalPty, type LocalPtyDeps } from './machine-local-pty.js';
import { runDetached } from './machine-run.js';
import { type AgentAvailability, type Exec, LOCAL_MACHINE } from './types.js';

export { LOCAL_DISK, localDisk } from './machine-local-disk.js';

export interface LocalMachineDeps extends Omit<LocalPtyDeps, 'env' | 'platform'> {
  exec: Exec; // the server's own: tests see every call, as today
  agents: readonly AgentAvailability[]; // what boot detected (#516); 7.4 detects per machine
  env?: NodeJS.ProcessEnv; // process.env unless a test injects one
  platform?: NodeJS.Platform; // process.platform unless a test injects one
}

// stdio left at its default, three pipes: spawn's type is then ChildProcessWithoutNullStreams
const localProcess = (command: string, args: string[], { cwd, env, windowsVerbatimArguments }: ProcessOptions): MachineChild =>
  spawn(command, args, { cwd, env, windowsVerbatimArguments });

export function createLocalMachine(deps: LocalMachineDeps): Machine {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  let read: MachineInfo | undefined; // nothing it holds changes while the Hive runs
  return {
    id: LOCAL_MACHINE, ...localDisk(deps.exec), run: runDetached, process: localProcess, paths: pathsOf(platform), watch: localWatch,
    pty: createLocalPty({ ...deps, env, platform }),
    info: () => {
      read ??= infoOf(env, platform, deps.agents);
      return read;
    },
  };
}
