// One fake machine for unit and route tests (#160), and the only place a test names the machine's shape: the local machine's fs, run and
// info by default, an exec that refuses until a test hands one (a missed call site fails loudly), and no pty.
import type { Stats } from 'node:fs';
import { type Machine, MachineError, type MachineExec, type MachineFs, type MachineInfo, type MachinePty, type Machines } from '../src/machine.js';
import { createLocalMachine, toMachineError } from '../src/machine-local.js';
import { createPtyHost } from '../src/pty-host.js';
import type { LaunchPty, MachineId } from '../src/types.js';
import { fakePtys } from './fakes.js';

export interface FakeMachineOverrides { id?: MachineId; exec?: MachineExec; run?: Machine['run']; fs?: Partial<MachineFs>; info?: Partial<MachineInfo> }

const NO_LAUNCH: LaunchPty = () => ({ started: Promise.resolve(), kill: () => Promise.resolve() });
// Built once: what the host's own machine answers for fs, run and info
const LOCAL = createLocalMachine({
  exec: async () => ({ stdout: '' }), launch: NO_LAUNCH, ptys: createPtyHost(fakePtys().spawnPty), home: '/hive-home', secret: 'fake-secret-160',
  secretFile: '/hive-home/hive.secret', commandShims: '/hive-home/command-shims', port: () => 0, agents: [],
});

const noPty = (): never => {
  throw new Error('fakeMachine: no pty');
};
const NO_PTY: MachinePty = { spawn: noPty, write: noPty, resize: noPty, subscribe: noPty, kill: noPty, pid: noPty, has: noPty, adopt: noPty, forget: noPty };

const refusingExec: MachineExec = async (file, args) => {
  throw new MachineError(`fakeMachine: no exec for ${[file, ...args].join(' ')}`);
};
// The test's own exec, its rejection rebuilt as the local machine rebuilds execFile's
const asMachineExec = (exec: MachineExec): MachineExec => async (file, args, opts) => {
  try {
    return await exec(file, args, opts);
  } catch (err) {
    throw toMachineError(err);
  }
};

export function fakeMachine(over: FakeMachineOverrides = {}): Machine {
  const info: MachineInfo = { ...LOCAL.info(), ...over.info };
  return {
    id: over.id ?? LOCAL.id, fs: { ...LOCAL.fs, ...over.fs }, exec: over.exec === undefined ? refusingExec : asMachineExec(over.exec),
    run: over.run ?? LOCAL.run, pty: NO_PTY, info: () => info,
  };
}

/** `machine` for every activity: createServer({ machines }). */
export const fakeMachines = (machine: Machine): Machines => ({ local: machine, for: () => machine });

/** A Stats for a fake fs: only what the probes read. */
export const statsOf = (kind: 'file' | 'folder'): Stats =>
  ({ isFile: () => kind === 'file', isDirectory: () => kind === 'folder', isSymbolicLink: () => false }) as unknown as Stats;

/** A disk holding `files` only, each executable, matched case-insensitively as NTFS does; anything else is ENOENT. */
export function fakeFiles(...files: string[]): Pick<MachineFs, 'access' | 'stat'> {
  const held = new Set(files.map((file) => file.toLowerCase()));
  const check = (path: string): void => {
    if (!held.has(path.toLowerCase())) throw new MachineError(`ENOENT: ${path}`, { code: 'ENOENT' });
  };
  return {
    access: async (path) => check(path),
    stat: async (path) => {
      check(path);
      return statsOf('file');
    },
  };
}
