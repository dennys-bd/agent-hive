// The machines registry (#931, leaf 2.1 of #930): the local machine for 'local', a distro's machine for 'wsl:<distro>' from the factory the
// server hands on win32 (#945), and for any id it cannot serve a machine that refuses every call, so a caller fails the way any machine call fails.
import { type Machine, MachineError, type MachineFs, type MachinePty, type Machines, pathsOf } from './machine.js';
import type { Refusal } from './server-tasks.js';
import { LOCAL_MACHINE, type MachineId, WSL_MACHINE_PREFIX } from './types.js';

const HTTP_CONFLICT = 409;

export const NOT_WINDOWS = 'not_windows'; // a wsl: id off win32
export const NOT_SUPPORTED = 'not_supported'; // a wsl: id with no factory, or an id that is neither local nor wsl:

const isUnavailable = (err: unknown): err is MachineError => err instanceof MachineError && err.code === MachineError.UNAVAILABLE;

/** The 409 of a call on a machine the registry cannot serve (#931, #932), the start route's shape: its words, code, id and why. Undefined
 *  for any other failure, which stays the caller's. */
export function unavailableRefusal(err: unknown, machineId: MachineId): Refusal | undefined {
  if (!isUnavailable(err)) return undefined;
  return { status: HTTP_CONFLICT, message: err.message, code: MachineError.UNAVAILABLE, machine: machineId, ...(err.reason === undefined ? {} : { reason: err.reason }) };
}

/** Whether a workspace's machine can be reached at all, before anything runs on it (#931): one stat of its folder. A folder that is only
 *  missing refuses nothing here; the caller's own check names it. */
export async function machineRefusal(machine: Pick<Machine, 'id' | 'fs'>, path: string): Promise<Refusal | undefined> {
  try {
    await machine.fs.stat(path);
    return undefined;
  } catch (err) {
    return unavailableRefusal(err, machine.id);
  }
}

/** One workspace's share of a read over many (#932): a workspace whose machine is unavailable answers `none`, never the whole answer's
 *  failure. `work` is a thunk so a sync throw (an unavailable machine's info()) is caught too. */
export async function whenAvailable<T>(work: () => Promise<T>, none: T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUnavailable(err)) return none;
    throw err;
  }
}

/** A machine that may hold something the quit must end: a distro's helper (#945). */
export type ClosableMachine = Machine & { close?(): void };
export interface MachinesDeps { local: Machine; platform: NodeJS.Platform; wsl?: (distro: string) => ClosableMachine }
/** The registry createMachines builds (#945): close() closes every machine it made; the Machines interface itself is unchanged. */
export type MachineRegistry = Machines & { close(): void };

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
  // As a remote watch's start-up failure (#935): on the next microtask, unless close() ran first, so the root falls back to its poll
  const watch: Machine['watch'] = (_path, _options, _onEvent, onError) => {
    let isClosed = false;
    queueMicrotask(() => { if (!isClosed) onError(error()); });
    return { close: () => { isClosed = true; } };
  };
  // paths: a distro's disk is Linux; an unknown id has no disk to join paths on, and every call of it fails anyway
  return { id, fs, pty, exec: reject, run: reject, process: fail, info: fail, paths: pathsOf('linux'), watch };
}

const buildFor = (id: MachineId, { platform, wsl }: MachinesDeps): ClosableMachine => {
  if (!id.startsWith(WSL_MACHINE_PREFIX)) return unavailableMachine(id, NOT_SUPPORTED);
  if (platform !== 'win32') return unavailableMachine(id, NOT_WINDOWS);
  return wsl ? wsl(id.slice(WSL_MACHINE_PREFIX.length)) : unavailableMachine(id, NOT_SUPPORTED);
};

export function createMachines(deps: MachinesDeps): MachineRegistry {
  const made = new Map<MachineId, ClosableMachine>(); // each non-local answer once per id: a real distro machine holds its helper
  return {
    local: deps.local,
    for: ({ machine }) => {
      if (machine === undefined || machine === LOCAL_MACHINE) return deps.local;
      const known = made.get(machine) ?? buildFor(machine, deps);
      made.set(machine, known);
      return known;
    },
    // the quit's (decision 14): no distro's helper outlives the Hive; local is the server's own and holds no child of its own here
    close: () => {
      for (const machine of made.values()) machine.close?.();
    },
  };
}
