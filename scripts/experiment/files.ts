import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readJson<T>(path: string, parse: (raw: unknown) => T = (raw) => raw as T): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parse(JSON.parse(text));
}

// Temp file and rename: a reader never sees half a file
export async function writeText(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

export const writeJson = (path: string, value: unknown): Promise<void> => writeText(path, `${JSON.stringify(value, null, 2)}\n`);

export async function pngsIn(dir: string, keep: (name: string) => boolean = () => true): Promise<string[]> {
  const names = await readdir(dir).catch((): string[] => []);
  return names.filter((name) => name.endsWith('.png') && keep(name)).sort().map((name) => join(dir, name));
}

export interface Store<T> { get(): T; update(change: (value: T) => T): Promise<T> }

/** One JSON file changed by concurrent callers (both runs of a pair): each change applies to the latest value and is written in turn. */
export function serialStore<T>(path: string, initial: T): Store<T> {
  let value = initial;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    get: () => value,
    update(change) {
      const next = tail.then(async () => {
        value = change(value);
        await writeJson(path, value);
        return value;
      });
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
