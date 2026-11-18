// The machine a test hands a function that takes one (#161): the local machine over a fake exec and no pty, or one whose info() answers an
// actor's facts. Nothing here spawns a pty; an exec a test does not inject answers ''.
import type { Machine, MachineInfo } from '../src/machine.js';
import { createLocalMachine, type LocalMachineDeps } from '../src/machine-local.js';
import { createPtyHost, NO_PTY } from '../src/pty-host.js';
import type { LaunchPty } from '../src/types.js';

const NO_LAUNCH: LaunchPty = () => ({ started: Promise.resolve(), kill: () => Promise.resolve() });

export const localDeps = (over: Partial<LocalMachineDeps> = {}): LocalMachineDeps => ({
  exec: async () => ({ stdout: '' }), launch: NO_LAUNCH, ptys: createPtyHost(NO_PTY), home: '/hive-home', secret: 'fake-secret-158',
  secretFile: '/hive-home/hive.secret', commandShims: '/hive-home/command-shims', port: () => 4242, agents: [], ...over,
});

/** The local machine. Its env (process.env unless given) is what info() reads CLAUDE_CONFIG_DIR, CODEX_HOME and PATH from, at its first call. */
export const fakeMachine = (over: Partial<LocalMachineDeps> = {}): Machine => createLocalMachine(localDeps(over));

/** A machine whose info() answers `facts` over a local one with an empty env: an actor's home, never the developer's ~/.claude. */
export function machineWith(facts: Partial<MachineInfo>, base: Machine = fakeMachine({ env: {} })): Machine {
  return { ...base, info: () => ({ ...base.info(), ...facts }) };
}
