import { type ExecLookup, findExec } from './exec-path.js';
import { FORMATTERS } from './formatters.js';
import { type Machine, type MachineFs, type MachineInfo, pathsOf } from './machine.js';
import type { FormatterId } from './types.js';

// "Installed" (#749): a few stats per formatter on every ask, never cached, since a worker may install a dependency at any time. Every probe
// is on the machine the folder is on (#160).

const X_OK = 1; // node:fs's constants.X_OK: node:fs is a restricted import here (#158)

/** What a lookup probes (#160): a machine's fs, or HOST's for a host-only caller. */
export type ExecProbe = Pick<MachineFs, 'access' | 'stat'>;
/** What a lookup reads of a machine: its probes, and its platform and PATH. A Machine is one; so is HOST (host-fs.ts). */
export interface ExecHost { fs: ExecProbe; info(): Pick<MachineInfo, 'platform' | 'path'>; readonly paths: Machine['paths'] }

// A regular file this process may run: access alone also passes a folder
async function isExecutable(fs: ExecProbe, path: string): Promise<boolean> {
  try {
    await fs.access(path, X_OK);
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

// Where a candidate may be: one with a slash under the activity's folder (the project pins its version there), a bare name in each PATH folder
const placesOf = (candidate: string, folder: string, dirs: string[], paths: Machine['paths']): string[] =>
  candidate.includes('/') ? [paths.join(folder, candidate)] : dirs.map((dir) => paths.join(dir, candidate));

async function firstExecutable(fs: ExecProbe, paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await isExecutable(fs, path)) return path;
  }
  return undefined;
}

/** findOnPath's platform and win32 file system, which its host-only callers' tests fake. */
export interface DetectLookup {
  readonly platform?: NodeJS.Platform;
  readonly isFile?: ExecLookup['isFile'];
}

// On win32 a file is runnable by its PATHEXT extension, not a mode bit (X_OK only checks it exists there), so the lookup is exec-path's
// (#632). A candidate with a slash is the project's copy, an absolute name under the folder; a bare one goes through PATH.
const findWin32 = (candidates: readonly string[], folder: string, pathList: string, isFile: (file: string) => boolean): string | undefined => {
  const env = { PATH: pathList, PATHEXT: process.env.PATHEXT };
  for (const candidate of candidates) {
    const name = candidate.includes('/') ? pathsOf('win32').join(folder, candidate) : candidate;
    const found = findExec(name, { platform: 'win32', env, isFile });
    if (found !== undefined) return found;
  }
  return undefined;
};

// findExec's isFile is synchronous and a machine's stat is not (#160): a first pass answering false names every path the lookup would try,
// those are stat'ed at once on the machine, and the second pass reads the answers
async function probedIsFile(fs: ExecProbe, lookup: (isFile: (file: string) => boolean) => unknown): Promise<(file: string) => boolean> {
  const asked: string[] = [];
  lookup((file) => {
    asked.push(file);
    return false;
  });
  const found = await Promise.all(asked.map((file) => fs.stat(file).then((s) => s.isFile(), () => false)));
  const files = new Set(asked.filter((_, i) => found[i]));
  return (file) => files.has(file);
}

async function onWin32(fs: ExecProbe, candidates: readonly string[], folder: string, path: string, isFile?: ExecLookup['isFile']): Promise<string | undefined> {
  const lookup = (probe: (file: string) => boolean): string | undefined => findWin32(candidates, folder, path, probe);
  return lookup(isFile ?? (await probedIsFile(fs, lookup)));
}

/** The first of `candidates` installed for `folder` on `on`'s machine (#749, #782, #160): one with a slash under the folder (the project's
 * copy) before a bare name in each of `path`'s folders, the machine's own PATH unless the caller passes the run's. */
export const findCandidate = (on: ExecHost, candidates: readonly string[], folder: string, path = on.info().path): Promise<string | undefined> => {
  if (on.info().platform === 'win32') return onWin32(on.fs, candidates, folder, path);
  const dirs = path.split(on.paths.delimiter).filter((dir) => dir !== '');
  return firstExecutable(on.fs, candidates.flatMap((c) => placesOf(c, folder, dirs, on.paths)));
};

/** Each of `ids`' binary when it is installed for `folder` (#749): its first candidate that is an executable file, the project's local one
 * before the machine's PATH. A formatter with none is absent from the answer. */
export async function detectFormatters(on: ExecHost, folder: string, ids: readonly FormatterId[], path = on.info().path): Promise<Partial<Record<FormatterId, string>>> {
  const found = await Promise.all(FORMATTERS.filter((def) => ids.includes(def.id)).map(async (def) => [def.id, await findCandidate(on, def.candidates, folder, path)] as const));
  return Object.fromEntries(found.filter(([, binary]) => binary !== undefined));
}

/** The first executable `name` in `path`'s folders (#780): an install's requires check and a server's run check, on the host (HOST.fs). */
export const findOnPath = (fs: ExecProbe, name: string, path: string, lookup: DetectLookup = {}): Promise<string | undefined> => {
  const platform = lookup.platform ?? process.platform;
  if (platform === 'win32') return onWin32(fs, [name], '', path, lookup.isFile);
  const paths = pathsOf(platform);
  return firstExecutable(fs, path.split(paths.delimiter).filter((dir) => dir !== '').map((dir) => paths.join(dir, name)));
};
