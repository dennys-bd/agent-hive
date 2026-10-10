import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// One JSON file per key (#591, #592), outside State: a task's review, a PR's review. The store queues each key's read-for-write and writes
// atomically (temp + rename), so two edits in flight never drop each other's change.

export interface JsonStore<T> {
  read(key: string): Promise<T>; // a missing file reads as `empty`
  update(key: string, edit: (file: T) => T): Promise<T>; // queued per key; written only when edit changed it and the key is live
  remove(key: string): Promise<void>;
}

/** private: the folder 0700 and each file 0600, for a store of text the user would not share (the memory's lessons, #797). isLive: whether the key still belongs to the State. An edit landing after it left writes nothing, so it never brings back the file its
 * removal took. parse throws on anything that is not the file: the store never overwrites it. */
export interface JsonStoreSpec<T> { pathOf(key: string): string; empty: T; parse(raw: unknown): T; isLive(key: string): boolean; private?: boolean }

export function createJsonStore<T>({ pathOf, empty, parse, isLive, private: owned = false }: JsonStoreSpec<T>): JsonStore<T> {
  const queues = new Map<string, Promise<unknown>>();
  async function read(key: string): Promise<T> {
    try {
      return parse(JSON.parse(await readFile(pathOf(key), 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
      throw err;
    }
  }
  function queued<R>(key: string, job: () => Promise<R>): Promise<R> {
    const next = (queues.get(key) ?? Promise.resolve()).then(job, job);
    const tail = next.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return next;
  }
  async function write(key: string, file: T): Promise<void> {
    const path = pathOf(key);
    await mkdir(dirname(path), { recursive: true, ...(owned ? { mode: 0o700 } : {}) });
    await writeFile(`${path}.tmp`, JSON.stringify(file, null, 2), owned ? { mode: 0o600 } : undefined);
    await rename(`${path}.tmp`, path);
  }
  return {
    read,
    update: (key, edit) => queued(key, async () => {
      const current = await read(key);
      const next = edit(current);
      if (next !== current && isLive(key)) await write(key, next);
      return next;
    }),
    remove: (key) => queued(key, () => rm(pathOf(key), { force: true })),
  };
}
