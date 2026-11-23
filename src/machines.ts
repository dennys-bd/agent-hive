// The machines registry (#931, leaf 2.1 of #930): the local machine for 'local', a distro's machine for 'wsl:<distro>' once 5.3 hands a
// factory, and for any id it cannot serve a machine that refuses every call, so a caller fails the way any machine call fails.
import { type Machine, MachineError, type MachineFs, type MachinePty, type Machines, pathsOf } from './machine.js';
import { LOCAL_MACHINE, type MachineId, WSL_MACHINE_PREFIX } from './types.js';

export const NOT_WINDOWS = 'not_windows'; // a wsl: id off win32
export const NOT_SUPPORTED = 'not_supported'; // no factory for it yet (5.3), or an id that is neither local nor wsl:

export interface MachinesDeps { local: Machine; platform: NodeJS.Platform; wsl?: (distro: string) => Machine }

export function unavailableMachine(id: MachineId, reason: string): Machine {
  const error = (): MachineError => new MachineError(`machine ${id} is unavailable: ${reason}`, { code: MachineError.UNAVAILABLE, reason });
  const reject = async (): Promise<never> => { throw error(); };
  const fail = (): never => { throw error(); };
  const fs: MachineFs = {
    stat: reject, lstat: reject, realpath: reject, access: reject, readdir: reject, readFile: reject,
    readLines: () => ({ [Symbol.asyncIterator]: () => ({ next: reject }) }), // refused on the first next(), as readFile's own refusals are
    writeFile: reject, writeAtomic: reject, mkdir: reject, mkdtemp: reject, rename: reject, rm: reject, cp: reject,
    copyFile: reject, link: reject, chmod: reject, unlink: reject, appendFile: reject,
  };
  // as for a pty it never had: nothing to write, resize, kill or subscribe to
  const pty: MachinePty = {
    spawn: fail, has: () => false, pid: () => undefined, write: () => false, resize: () => false, kill: () => false,
    subscribe: () => undefined, adopt: () => {}, forget: () => {},
  };
  // paths: a distro's disk is Linux; an unknown id has no disk to join paths on, and every call of it fails anyway
  return { id, fs, pty, exec: reject, run: reject, process: fail, info: fail, paths: pathsOf('linux') };
}

const buildFor = (id: MachineId, { platform, wsl }: MachinesDeps): Machine => {
  if (!id.startsWith(WSL_MACHINE_PREFIX)) return unavailableMachine(id, NOT_SUPPORTED);
  if (platform !== 'win32') return unavailableMachine(id, NOT_WINDOWS);
  return wsl ? wsl(id.slice(WSL_MACHINE_PREFIX.length)) : unavailableMachine(id, NOT_SUPPORTED);
};

export function createMachines(deps: MachinesDeps): Machines {
  const made = new Map<MachineId, Machine>(); // each non-local answer once per id: a real distro machine holds its helper
  return {
    local: deps.local,
    for: ({ machine }) => {
      if (machine === undefined || machine === LOCAL_MACHINE) return deps.local;
      const known = made.get(machine) ?? buildFor(machine, deps);
      made.set(machine, known);
      return known;
    },
  };
}
