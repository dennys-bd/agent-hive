// The seams this node's files already had (#160), built over the activity's Machine: the tree's guards (tree-paths.ts), its own operations
// (server-tree-ops.ts), the drop (server-move.ts) and the file routes' resolve (ide.ts) run unchanged on whatever machine. No node:fs here:
// the lint holds this file like any other.
import { type Machine, MachineError, type MachineInfo } from './machine.js';
import type { MoveFs } from './server-move.js';
import type { Refusal } from './server-tasks.js';
import type { TreeFs } from './server-tree-ops.js';
import type { PathFs } from './tree-paths.js';

const LOCAL_ID = 'local'; // machine-local.ts' id for the host's own machine (#158)
const HTTP_CONFLICT = 409;
export const MACHINE_REMOTE = 'machine_remote';
export const MACHINE_REMOTE_MESSAGE = "this acts on this computer's desktop, not on the task's machine";
/** What a route acting on the host's desktop answers for an activity on another machine (#160), before any disk touch. */
export const REMOTE_REFUSAL: Refusal = { status: HTTP_CONFLICT, message: MACHINE_REMOTE_MESSAGE, code: MACHINE_REMOTE };

/** Until node 8 only a test's fake machine answers false. */
export const isLocal = (machine: Pick<Machine, 'id'>): boolean => machine.id === LOCAL_ID;

/** A MachineError's code (too_large, not_file, an errno, an exit code), else undefined. */
export const machineCode = (err: unknown): string | number | undefined => (err instanceof MachineError ? err.code : undefined);

// lstat, not stat: a symlink is the item, not its target, and a dangling one still holds its name, so no free name lands on it
export const pathFs = ({ fs }: Pick<Machine, 'fs'>): PathFs => ({ realpath: (path) => fs.realpath(path), stat: (path) => fs.lstat(path) });

export function treeFs(machine: Pick<Machine, 'fs'>): TreeFs {
  const { fs } = machine;
  return {
    ...pathFs(machine),
    mkdirs: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    mkdir: async (path) => {
      await fs.mkdir(path);
    },
    writeNew: (path, text) => fs.writeFile(path, text, { flag: 'wx' }),
    replace: async (path, text) => {
      await fs.writeAtomic(path, text);
    },
    rename: (from, to) => fs.rename(from, to),
    // one inode: a case-insensitive volume resolves `A.ts` to `a.ts`, a case-sensitive one does not
    sameFile: async (a, b) => {
      const [first, second] = await Promise.all([fs.lstat(a, { bigint: true }), fs.lstat(b, { bigint: true })]).catch(() => []);
      return first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino;
    },
  };
}

// cp keeps a link a link and never overwrites
export const moveFs = (machine: Pick<Machine, 'fs'>): MoveFs => ({
  ...pathFs(machine),
  rename: (from, to) => machine.fs.rename(from, to),
  cp: (from, to) => machine.fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }),
  rm: (path) => machine.fs.rm(path, { recursive: true }),
});

/** What resolveActivityPath reads (#258): realpath follows symlinks, so a link out of the task's folder is caught. */
export interface FileFs { realpath(path: string): Promise<string>; isFile(path: string): Promise<boolean> }
export const fileFs = ({ fs }: Pick<Machine, 'fs'>): FileFs => ({
  realpath: (path) => fs.realpath(path),
  isFile: (path) => fs.stat(path).then((s) => s.isFile(), () => false),
});

/** A run's env base on the machine (#160): `base` with PATH as the machine's own; the workspace's env goes on top at the caller. On win32
 *  every other spelling of PATH (Path) goes first, so the child sees one key. */
export function withMachinePath(base: NodeJS.ProcessEnv, { platform, path }: Pick<MachineInfo, 'platform' | 'path'>): NodeJS.ProcessEnv {
  const kept = platform === 'win32' ? Object.fromEntries(Object.entries(base).filter(([name]) => name.toUpperCase() !== 'PATH')) : base;
  return { ...kept, PATH: path };
}
