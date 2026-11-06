import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join, win32 } from 'node:path';
import { type ExecLookup, findExec } from './exec-path.js';
import { FORMATTERS } from './formatters.js';
import type { FormatterId } from './types.js';

// "Installed" (#749): a few stats per formatter on every ask, never cached, since a worker may install a dependency at any time.

// A regular file this process may run: access alone also passes a folder
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// Where a candidate may be: one with a slash under the activity's folder (the project pins its version there), a bare name in each PATH folder
const placesOf = (candidate: string, folder: string, dirs: string[]): string[] =>
  candidate.includes('/') ? [join(folder, candidate)] : dirs.map((dir) => join(dir, candidate));

async function firstExecutable(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await isExecutable(path)) return path;
  }
  return undefined;
}

/** The platform the lookup answers for; `isFile` fakes the win32 file system in a test. Left out it is process.platform, until the call
 *  sites pass it with the resolver (#633, #634, #635). */
export interface DetectLookup {
  readonly platform?: NodeJS.Platform;
  readonly isFile?: ExecLookup['isFile'];
}

// On win32 a file is runnable by its PATHEXT extension, not a mode bit (X_OK only checks it exists there), so the lookup is exec-path's
// (#632). A candidate with a slash is the project's copy, an absolute name under the folder; a bare one goes through PATH.
const findWin32 = (candidates: readonly string[], folder: string, pathList: string, isFile: ExecLookup['isFile']): string | undefined => {
  const env = { PATH: pathList, PATHEXT: process.env.PATHEXT };
  for (const candidate of candidates) {
    const name = candidate.includes('/') ? win32.join(folder, candidate) : candidate;
    const found = findExec(name, { platform: 'win32', env, isFile });
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The first of `candidates` installed for `folder` (#749, #782): one with a slash under the folder (the project's copy) before a bare name in
 * each of `path`'s folders. */
export const findCandidate = (candidates: readonly string[], folder: string, path: string, lookup: DetectLookup = {}): Promise<string | undefined> => {
  if ((lookup.platform ?? process.platform) === 'win32') return Promise.resolve(findWin32(candidates, folder, path, lookup.isFile));
  const dirs = path.split(delimiter).filter((dir) => dir !== '');
  return firstExecutable(candidates.flatMap((c) => placesOf(c, folder, dirs)));
};

/** Each of `ids`' binary when it is installed for `folder` (#749): its first candidate that is an executable file, the project's local one
 * before the daemon's PATH. A formatter with none is absent from the answer. */
export async function detectFormatters(folder: string, ids: readonly FormatterId[], path = process.env.PATH ?? '', lookup: DetectLookup = {}): Promise<Partial<Record<FormatterId, string>>> {
  const found = await Promise.all(FORMATTERS.filter((def) => ids.includes(def.id)).map(async (def) => [def.id, await findCandidate(def.candidates, folder, path, lookup)] as const));
  return Object.fromEntries(found.filter(([, binary]) => binary !== undefined));
}

/** The first executable `name` in `path`'s folders (#780): an install's requires check and a server's run check. */
export const findOnPath = (name: string, path: string, lookup: DetectLookup = {}): Promise<string | undefined> =>
  (lookup.platform ?? process.platform) === 'win32'
    ? Promise.resolve(findWin32([name], '', path, lookup.isFile))
    : firstExecutable(path.split(delimiter).filter((dir) => dir !== '').map((dir) => join(dir, name)));
