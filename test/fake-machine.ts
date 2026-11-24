// The machine a test hands a function that takes one (#160, #161): the local machine over a fake exec and a pty host that launches nothing,
// with any of its deps (env, platform...) given, and the fs, run, info or id a test overrides on top. An exec a test does not inject answers ''.
import type { Stats } from 'node:fs';
import { type Machine, MachineError, type MachineFs, type MachineInfo, type Machines, pathsOf } from '../src/machine.js';
import { createLocalMachine, type LocalMachineDeps } from '../src/machine-local.js';
import { createPtyHost, NO_PTY } from '../src/pty-host.js';
import type { Exec, LaunchPty, MachineId } from '../src/types.js';

/** What a test overrides on the built machine, over the local one's. */
export interface FakeMachineOverrides { id?: MachineId; run?: Machine['run']; fs?: Partial<MachineFs>; info?: Partial<MachineInfo> }

const NO_LAUNCH: LaunchPty = () => ({ started: Promise.resolve(), kill: () => Promise.resolve() });

/** git's top level of `git -C <folder> rev-parse --show-toplevel` is `<folder>` (#932): the settings save and the Settings reads check a local
 *  workspace with machines.local's git, the test's fake. An answer the fake gives itself, or a refusal, is kept as it is. */
export const withToplevel = (exec: Exec): Exec => async (file, args, opts) => {
  const answer = await exec(file, args, opts);
  const at = args.indexOf('-C');
  if (file !== 'git' || !args.includes('--show-toplevel') || answer.stdout.trim() !== '' || at < 0) return answer;
  return { ...answer, stdout: `${args[at + 1]}\n` };
};

export const localDeps = (over: Partial<LocalMachineDeps> = {}): LocalMachineDeps => ({
  exec: withToplevel(async () => ({ stdout: '' })), launch: NO_LAUNCH, ptys: createPtyHost(NO_PTY), home: '/hive-home', secret: 'fake-secret-158',
  secretFile: '/hive-home/hive.secret', commandShims: '/hive-home/command-shims', port: () => 4242, agents: [],
  pluginDir: (workspace) => `/hive-home/plugins/${workspace}`, lspDir: () => undefined, ...over, // #947: the pty launches nothing, so no folder need exist
});

/** The local machine over the given deps, with its id, fs, run and info overridden where given. Its env (process.env unless given) is what
 *  info() reads CLAUDE_CONFIG_DIR, CODEX_HOME and PATH from, at its first call. */
export function fakeMachine({ id, run, fs, info, ...deps }: Partial<LocalMachineDeps> & FakeMachineOverrides = {}): Machine {
  // its exec rebuilds a test exec's rejection as a MachineError; #932: and answers git's top level as the folder asked
  const base = createLocalMachine(localDeps({ ...deps, ...(deps.exec === undefined ? {} : { exec: withToplevel(deps.exec) }) }));
  const facts: MachineInfo | undefined = info === undefined ? undefined : { ...base.info(), ...info };
  return { ...base, id: id ?? base.id, fs: { ...base.fs, ...fs }, run: run ?? base.run,
    info: facts === undefined ? base.info : () => facts, paths: info?.platform === undefined ? base.paths : pathsOf(info.platform) };
}

/** A machine whose info() answers `facts` over a local one with an empty env: an actor's home, never the developer's ~/.claude. */
export function machineWith(facts: Partial<MachineInfo>, base: Machine = fakeMachine({ env: {} })): Machine {
  return { ...base, info: () => ({ ...base.info(), ...facts }), paths: facts.platform === undefined ? base.paths : pathsOf(facts.platform) };
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

/** The flavour fakeMachine() answers when no platform is given: the host's, for a fake of PathFs, TreeFs or a file query on host paths (#929). */
export const HOST_PATHS = pathsOf(process.platform);
