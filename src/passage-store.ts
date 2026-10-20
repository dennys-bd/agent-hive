// The user's protocol passages on disk (#336): one Liquid file each under <home>/protocol/passages/, beside the protocol files they end up
// in (the workspaces/ subfolder keeps workspace names apart). Not under <home>/custom/<origin>/, which is keyed by workspace name. One
// promise chain, each write temp + rename, private like the protocol files. Apart from src/protocol-inserts.ts, which stays node-free.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTOCOL_DIR } from './hooks-settings.js';
import type { Logger } from './log.js';
import { errorName } from './memory.js';
import { type ProtocolFor, protocolTexts } from './protocol.js';
import { type Passage, passageErrors, renderPassages } from './protocol-inserts.js';
import type { TemplateError } from './template.js';

const PASSAGES_DIR = 'passages';
const SUFFIX = '.md.liquid';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const FILE_NAME = /^p([1-9]\d*)\.md\.liquid$/;
const ID = /^p[1-9]\d*$/; // also the guard that keeps a route's :id inside the folder

export const passagesDir = (home: string): string => join(home, PROTOCOL_DIR, PASSAGES_DIR);
export type PassageSave = { id: string } | { errors: TemplateError[] };
export interface PassageStore {
  list(): Promise<Passage[]>; // id order; no folder is none
  create(text: string): Promise<PassageSave>;
  change(id: string, text: string): Promise<PassageSave | undefined>; // undefined: no passage `id`
  remove(id: string): Promise<boolean>; // false: no passage `id`
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function readAll(dir: string): Promise<Passage[]> {
  const names = await readdir(dir).catch((err: unknown) => (isMissing(err) ? [] : Promise.reject(err)));
  const numbered = names.flatMap((name) => { const match = FILE_NAME.exec(name); return match ? [{ name, n: Number(match[1]) }] : []; }).sort((a, b) => a.n - b.n);
  return Promise.all(numbered.map(async ({ name, n }) => ({ id: `p${n}`, text: await readFile(join(dir, name), 'utf8') })));
}

const refusalOf = (text: string): PassageSave | undefined => {
  const errors = passageErrors(text);
  return errors.length > 0 ? { errors } : undefined;
};

export function createPassageStore(home: string): PassageStore {
  const dir = passagesDir(home);
  const pathOf = (id: string): string => join(dir, `${id}${SUFFIX}`);
  let chain: Promise<unknown> = Promise.resolve();
  // A failed write rejects its own caller only: the chain goes on with the next one
  const queued = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job);
    chain = next.catch(() => undefined);
    return next;
  };
  // A run starting mid-write reads the old passage or the new one, never half
  const put = async (id: string, text: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await writeFile(`${pathOf(id)}.tmp`, text, { mode: FILE_MODE });
    await rename(`${pathOf(id)}.tmp`, pathOf(id));
  };
  const create = async (text: string): Promise<PassageSave> => {
    const refusal = refusalOf(text);
    if (refusal !== undefined) return refusal;
    // The next number after the highest present, read on the chain: two creates in flight never share one
    return queued(async () => {
      const ids = (await readAll(dir)).map((p) => Number(p.id.slice(1)));
      const id = `p${Math.max(0, ...ids) + 1}`;
      await put(id, text);
      return { id };
    });
  };
  const change = async (id: string, text: string): Promise<PassageSave | undefined> => {
    if (!ID.test(id)) return undefined;
    return queued(async () => {
      if (!(await exists(pathOf(id)))) return undefined;
      const refusal = refusalOf(text);
      if (refusal !== undefined) return refusal;
      await put(id, text);
      return { id };
    });
  };
  const remove = async (id: string): Promise<boolean> => {
    if (!ID.test(id)) return false;
    return queued(() => rm(pathOf(id)).then(() => true, (err: unknown) => (isMissing(err) ? false : Promise.reject(err))));
  };
  return { list: () => readAll(dir), create, change, remove };
}

/** The memory store's protocolFor (#336): the passages rendered for the workspace into both protocols. One that fails there is left out and
 * logged, again on every rewrite, since each is a fresh render; a folder it cannot read costs the passages, never the protocol files. */
export function protocolRenderer(store: Pick<PassageStore, 'list'>, log: Pick<Logger, 'error'>): ProtocolFor {
  return async (workspace, off) => {
    const passages = await store.list().catch((err: unknown) => {
      log.error(`protocol: passages unreadable (${errorName(err)})`);
      return [];
    });
    const rendered = renderPassages(passages, workspace);
    for (const { id, errors } of rendered) for (const { line, message } of errors) log.error(`protocol ${workspace}: ${id}:${line} ${message}`);
    return protocolTexts(off, rendered);
  };
}
