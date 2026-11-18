// Copilot's folder trust (#880, node 8 of #608): Copilot asks once per folder no trustedFolders entry of <copilot home>/config.json covers, and an
// entry covers its subfolders (spike §8). Read only: the file is the CLI's managed state and may change shape between versions, so any shape
// this module does not know reads as unknown (undefined), never as an error and never as a log line
import { readFile, realpath } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';

const CONFIG_FILE = 'config.json';

/** trustedFolders' string entries, or undefined when the file is missing, unreadable, not JSON, or holds no trustedFolders array. */
export async function trustedFolders(home: string): Promise<readonly string[] | undefined> {
  let read: unknown;
  try {
    read = JSON.parse(await readFile(join(home, CONFIG_FILE), 'utf8'));
  } catch {
    return undefined; // missing, unreadable or not JSON: unknown by design (spec, "Unreadable state")
  }
  const entries = typeof read === 'object' && read !== null ? (read as { trustedFolders?: unknown }).trustedFolders : undefined;
  // one odd entry should not hide a correct answer: the strings still cover
  return Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === 'string') : undefined;
}

/** Whether `entry` is `folder` or one of its ancestors, by name, no I/O: never a sibling, a child or a prefix-only name. win32 ignores case,
 * as samePath does, and takes / for \. */
export function covers(entry: string, folder: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const fold = (p: string): string => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(fold(entry), fold(folder));
  // another drive answers an absolute path; an ancestor answers a relative one that never climbs
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// macOS's /tmp vs /private/tmp, a link to the repository: compare where both lead; a path realpath cannot read is compared as written
const resolved = (path: string): Promise<string> => realpath(path).catch(() => path);

/** The folders no entry covers, in input order and as passed (not resolved); undefined when the entries are unknown. */
export async function uncoveredFolders(home: string, folders: readonly string[], platform: NodeJS.Platform): Promise<readonly string[] | undefined> {
  const entries = await trustedFolders(home);
  if (entries === undefined) return undefined;
  const real = await Promise.all(entries.map(resolved));
  const checked = await Promise.all(folders.map(async (folder) => ({ folder, path: await resolved(folder) })));
  return checked.filter(({ path }) => !real.some((entry) => covers(entry, path, platform))).map(({ folder }) => folder);
}
