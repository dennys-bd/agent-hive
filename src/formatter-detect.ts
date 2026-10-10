import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
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

/** The first of `candidates` installed for `folder` (#749, #782): one with a slash under the folder (the project's copy) before a bare name in
 * each of `path`'s folders. */
export const findCandidate = (candidates: readonly string[], folder: string, path: string): Promise<string | undefined> => {
  const dirs = path.split(delimiter).filter((dir) => dir !== '');
  return firstExecutable(candidates.flatMap((c) => placesOf(c, folder, dirs)));
};

/** Each of `ids`' binary when it is installed for `folder` (#749): its first candidate that is an executable file, the project's local one
 * before the daemon's PATH. A formatter with none is absent from the answer. */
export async function detectFormatters(folder: string, ids: readonly FormatterId[], path = process.env.PATH ?? ''): Promise<Partial<Record<FormatterId, string>>> {
  const found = await Promise.all(FORMATTERS.filter((def) => ids.includes(def.id)).map(async (def) => [def.id, await findCandidate(def.candidates, folder, path)] as const));
  return Object.fromEntries(found.filter(([, binary]) => binary !== undefined));
}

/** The first executable `name` in `path`'s folders (#780): an install's requires check and a server's run check. */
export const findOnPath = (name: string, path: string): Promise<string | undefined> =>
  firstExecutable(path.split(delimiter).filter((dir) => dir !== '').map((dir) => join(dir, name)));
