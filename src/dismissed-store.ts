// The editor's dismissed annotations (#327): <home>/custom/<origin>/<name>/dismissed.json, { "<version or \u0000original>": keys }. Beside the
// item's version folders, never inside one: a version's files are delivered, a dismissal is the editor's own. The catalogue lists folders
// only, so the file is never read as a version.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isInside } from './ide.js';
import { customRoot, itemDir, type ItemKey } from './item-sources.js';
import type { Logger } from './log.js';
import { isRecord } from './rate-limits.js';

const DISMISSED_FILE = 'dismissed.json';
/** The original's key: no version name holds a NUL, so the two never meet. */
export const ORIGINAL_KEY = '\u0000original';
type Log = Pick<Logger, 'error'>;
type Dismissed = Readonly<Record<string, readonly string[]>>;

const keyOf = (version: string | null): string => version ?? ORIGINAL_KEY;
const isKeys = (value: unknown): value is string[] => Array.isArray(value) && value.every((key) => typeof key === 'string');

// The custom store's last guard: a file outside <home>/custom/ is never read or written
function fileOf(home: string, key: ItemKey): string {
  const file = join(itemDir(home, key), DISMISSED_FILE);
  if (!isInside(customRoot(home), file)) throw new Error(`${file} is outside the custom store`);
  return file;
}

// A missing file is no dismissal yet; one that does not parse is logged and read as empty, and the next write replaces it
async function readAll(file: string, log: Log): Promise<Dismissed> {
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  });
  if (text === undefined) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) throw new Error('not an object');
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string[]] => isKeys(entry[1])));
  } catch (err) {
    log.error(`dismissed: ${file} does not parse; read as empty: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** The keys dismissed in one version (null: the original); [] when none were. */
export async function readDismissed(home: string, key: ItemKey, version: string | null, log: Log): Promise<readonly string[]> {
  const all = await readAll(fileOf(home, key), log);
  return Object.hasOwn(all, keyOf(version)) ? all[keyOf(version)] : [];
}

/** One version's keys replaced. Every other version's stay, a deleted version's too: a stray entry costs nothing and nothing is deleted
 * silently; a renamed version starts with none.
 * ponytail: read-modify-write without a lock; the editor sends one PUT at a time, a queue if two windows ever write one item */
export async function writeDismissed(home: string, key: ItemKey, version: string | null, keys: readonly string[], log: Log): Promise<readonly string[]> {
  const file = fileOf(home, key);
  const all = await readAll(file, log);
  await mkdir(dirname(file), { recursive: true });
  // A temp file renamed over the old one: a crash mid-write leaves the old file, not a truncated one that reads as empty
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...all, [keyOf(version)]: keys }, null, 2)}\n`);
  await rename(temp, file);
  return keys;
}
