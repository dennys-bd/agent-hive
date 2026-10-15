// Where an item's files are (#315): the origin's (the shipped plugin, a workspace's main checkout's .claude/) and the custom store's under
// <home>/custom/. Read-only: the catalogue and the store share these reads, and only custom-store.ts writes.
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { FILES_DIR, mainFiles } from './custom-versions.js';
import { isRecord } from './rate-limits.js';
import { ITEM_KINDS, type ItemKind, type Workspace } from './types.js';

export const HIVE_ORIGIN = 'hive';
const CUSTOM_DIR = 'custom';
const SPECIALIST_FILE = /^(.+)\.md(?:\.liquid)?$/;
// The origins keep Claude Code's layout; only the store drops the kind from its path
const KIND_FOLDER: Record<ItemKind, string> = { skill: 'skills', specialist: 'agents' };

export interface ItemSources {
  home: string;
  pluginSource: string;
  workspaces: readonly Pick<Workspace, 'name' | 'path'>[];
}
export interface ItemRef {
  origin: string;
  kind: ItemKind;
  name: string;
}
export type ItemKey = Pick<ItemRef, 'origin' | 'name'>; // what an id holds: one name per origin, the kind is resolved
export interface FileSet {
  dir: string;
  paths: string[];
} // paths relative to dir, `/`-separated, sorted

// Only a missing folder reads as empty; any other failure is the caller's 500
const orMissing =
  <T>(empty: T) =>
  (err: unknown): T => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw err;
  };
const isSegment = (value: string): boolean => value !== '' && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');

export const itemId = ({ origin, name }: ItemKey): string => `${origin}:${name}`;

/** An id's two parts, each one path segment, so no id ever resolves outside its origin's folders; undefined for anything else. */
export function parseItemId(id: string): ItemKey | undefined {
  const [origin, name, ...rest] = id.split(':');
  if (rest.length > 0 || origin === undefined || name === undefined || !isSegment(origin) || !isSegment(name)) return undefined;
  return { origin, name };
}

export const customRoot = (home: string): string => join(home, CUSTOM_DIR);
export const originDir = (home: string, origin: string): string => join(customRoot(home), origin);
export const itemDir = (home: string, key: ItemKey): string => join(originDir(home, key.origin), key.name);
export const versionDir = (home: string, key: ItemKey, version: string): string => join(itemDir(home, key), version);

// The folder an origin keeps a kind in: the plugin's skills/ and agents/, a workspace's .claude/skills/ and .claude/agents/
function kindRoot(sources: ItemSources, origin: string, kind: ItemKind): string | undefined {
  if (origin === HIVE_ORIGIN) return join(sources.pluginSource, KIND_FOLDER[kind]);
  const workspace = sources.workspaces.find((w) => w.name === origin);
  return workspace && join(workspace.path, '.claude', KIND_FOLDER[kind]);
}

/** Every file under `dir`, relative, `/`-separated, sorted; [] when the folder is missing. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(orMissing<Dirent[]>([]));
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

/** The folders directly under `dir`, sorted; [] when it is missing. */
export async function childFolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(orMissing<Dirent[]>([]));
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** The names an origin offers for a kind: its skill folders, its specialists' `<name>.md` / `.md.liquid`. Listed as-is, even a name the
 * name rule would refuse: the rule is for names the user types. */
export async function originNames(sources: ItemSources, origin: string, kind: ItemKind): Promise<string[]> {
  const root = kindRoot(sources, origin, kind);
  if (root === undefined) return [];
  if (kind === 'skill') return childFolders(root);
  const files = await readdir(root).catch(orMissing<string[]>([]));
  return [...new Set(files.flatMap((file) => SPECIALIST_FILE.exec(file)?.[1] ?? []))].sort();
}

/** The origin's own files of an item; undefined when the origin has no such item (no main file). */
export async function originFiles(sources: ItemSources, ref: ItemRef): Promise<FileSet | undefined> {
  const root = kindRoot(sources, ref.origin, ref.kind);
  if (root === undefined) return undefined;
  const main = mainFiles(ref.kind, ref.name);
  if (ref.kind === 'skill') {
    const dir = join(root, ref.name);
    const paths = await listFiles(dir);
    return paths.some((p) => main.includes(p)) ? { dir, paths } : undefined;
  }
  const names = new Set(await readdir(root).catch(orMissing<string[]>([])));
  const paths = main.filter((file) => names.has(file));
  return paths.length === 0 ? undefined : { dir: root, paths };
}

/** The kind behind an id: the origin's skill, else its specialist (one name per origin, so a skill wins a clash), else a stored item's main
 * file, `SKILL.md*` or `<name>.md*` in a version's files/; undefined when nothing holds the name. */
export async function resolveRef(sources: ItemSources, key: ItemKey): Promise<ItemRef | undefined> {
  for (const kind of ITEM_KINDS) {
    if ((await originFiles(sources, { ...key, kind })) !== undefined) return { ...key, kind };
  }
  for (const version of await childFolders(itemDir(sources.home, key))) {
    const paths = await listFiles(join(versionDir(sources.home, key, version), FILES_DIR));
    const kind = ITEM_KINDS.find((k) => paths.some((path) => mainFiles(k, key.name).includes(path)));
    if (kind !== undefined) return { ...key, kind };
  }
  return undefined;
}

export async function versionFiles(home: string, key: ItemKey, version: string): Promise<FileSet> {
  const dir = join(versionDir(home, key, version), FILES_DIR);
  return { dir, paths: await listFiles(dir) };
}

/** Whether `base` holds exactly the origin's paths with the same bytes. false is "update available", also when the origin is gone. */
export async function sameFiles(origin: FileSet | undefined, base: string): Promise<boolean> {
  const paths = await listFiles(base);
  if (origin === undefined || paths.join('\n') !== origin.paths.join('\n')) return false;
  for (const path of paths) {
    const [shipped, kept] = await Promise.all([readFile(join(origin.dir, path)), readFile(join(base, path))]);
    if (!shipped.equals(kept)) return false;
  }
  return true;
}

/** The shipped plugin's `version`, kept in a Hive version's version.json as the version of its base. */
export async function pluginVersion(pluginSource: string): Promise<string | undefined> {
  const raw: unknown = JSON.parse(await readFile(join(pluginSource, '.claude-plugin', 'plugin.json'), 'utf8'));
  return isRecord(raw) && typeof raw.version === 'string' ? raw.version : undefined;
}
