import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Machine } from './machine.js';
import { checkRelativePath, parseSetup, type SetupStep } from './setup-script.js';
import { EDITOR_FILE_MAX, type Workspace } from './types.js';
import type { Phase } from './worktree-steps.js';

// A COPY / LOAD source (#299, #654), read under `root`: its real path must pass checkRelativePath against root's real path, so a symlink cannot
// lead out of that side, to its top or into .git / .hive. Missing is its own reason, named after the side.
const MISSING: Readonly<Record<string, string>> = { ENOENT: 'not found in', ENOTDIR: 'not a folder in' };

export async function insideRoot(machine: Machine, root: string, name: string, path: string): Promise<string> {
  const real = await machine.fs.realpath(join(root, path)).catch((err: NodeJS.ErrnoException) => {
    const reason = MISSING[err.code ?? ''];
    throw reason === undefined ? err : new Error(`${reason} ${name}`);
  });
  if (checkRelativePath(relative(await machine.fs.realpath(root), real), machine.paths) !== undefined) throw new Error(`outside ${name}`);
  return real;
}

// A relative destination (#299, #654): no folder on its way under `root` may be a symlink, or cp would write through it wherever a branch
// pointed it (a worker can commit `config -> ~/somewhere`). The last segment is fine for a file destination: cp with force replaces a link,
// never follows it. A folder destination (`whole`) is written into, so its last segment must not be a link either.
export async function refuseLinkedParent(machine: Machine, root: string, name: string, path: string, whole = false): Promise<void> {
  const parents = (whole ? path : dirname(path)).split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  for (let i = 1; i <= parents.length; i += 1) {
    const stat = await machine.fs.lstat(join(root, ...parents.slice(0, i))).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (stat === undefined) return; // cp creates the rest as plain folders
    if (stat.isSymbolicLink()) throw new Error(`outside ${name}`);
  }
}

const HOME = '~';

// Where a COPY writes (#654): the same relative path on the other side by default; `~` / `~/…` under the home folder and an absolute path
// as written (the user's own line, as a RUN cp would); a relative one under phase.to, where no folder on its way may be a symlink.
async function destinationOf(machine: Machine, phase: Phase, step: SetupStep): Promise<string> {
  const dest = step.dest ?? step.arg;
  if (dest === HOME || dest.startsWith(`${HOME}/`)) return join(machine.info().homedir, dest.slice(HOME.length));
  if (isAbsolute(dest)) return dest;
  await refuseLinkedParent(machine, phase.to, phase.toName, dest, step.arg.endsWith('/') || dest.endsWith('/'));
  return join(phase.to, dest);
}

// The files under `path`, for a result line: a folder's every non-folder entry, a symlink as one, never followed.
export async function countFiles(machine: Machine, path: string): Promise<number> {
  if (!(await machine.fs.lstat(path)).isDirectory()) return 1;
  return (await machine.fs.readdir(path, { recursive: true, withFileTypes: true })).filter((entry) => !entry.isDirectory()).length;
}

// The cp filter (#654): the worktree is untrusted, so a teardown never copies its symlinks (they would be planted in the main checkout), and
// in both phases a folder is never merged into a destination entry that is a symlink (cp would write through it, outside the side).
function copyFilter(machine: Machine, phase: Phase): (src: string, dest: string) => Promise<boolean> {
  return async (src, dest) => {
    const entry = await machine.fs.lstat(src);
    if (entry.isSymbolicLink()) return phase.name !== 'teardown';
    if (!entry.isDirectory()) return true;
    const existing = await machine.fs.lstat(dest).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (existing?.isSymbolicLink()) throw new Error(`outside ${phase.toName}`);
    return true;
  };
}

// COPY <source> [destination] (#654), rsync-like: a source ending in / must be a folder (checked below) and its contents
// land in the destination folder; any other source is copied to the destination path itself. fs.cp does both: it merges into a folder that
// exists, overwrites files and deletes nothing.
export async function copyStep(machine: Machine, phase: Phase, step: SetupStep): Promise<string> {
  const source = await insideRoot(machine, phase.from, phase.fromName, step.arg);
  // node's realpath drops a trailing /, so the ENOTDIR a file would answer never comes: check it here
  if (step.arg.endsWith('/') && !(await machine.fs.stat(source)).isDirectory()) throw new Error(`not a folder in ${phase.fromName}`);
  const dest = await destinationOf(machine, phase, step);
  // a file into `folder/` keeps its name, as cp does; a folder source into `folder/` is the rsync-like merge above
  const target = !step.arg.endsWith('/') && (step.dest ?? '').endsWith('/') && !(await machine.fs.lstat(source)).isDirectory() ? join(dest, basename(step.arg)) : dest;
  await machine.fs.cp(source, target, { recursive: true, force: true, filter: copyFilter(machine, phase) });
  return `copied ${await countFiles(machine, source)} files to ${step.dest ?? step.arg}`;
}

/** A LOAD's steps (#299): its file read from the main checkout on the machine, under the side's real path, one level only. */
export async function readLoad(machine: Machine, workspace: Pick<Workspace, 'path' | 'name'>, load: SetupStep): Promise<SetupStep[]> {
  const path = await insideRoot(machine, workspace.path, workspace.name, load.arg);
  const text = await machine.fs.readFile(path, { maxBytes: EDITOR_FILE_MAX, encoding: 'utf8' });
  return parseSetup(text, { allowLoad: false, paths: machine.paths });
}
