// The custom store (#315): the user's versions and items under <home>/custom/<origin>/<name>/<version>/. One promise chain per
// store, so two quick clicks never interleave; every write answers the workspaces it affects, or a refusal, and tells onChange (#316's
// render) only after a write that happened. The Hive never writes to the shipped plugin or to a workspace's repository.
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BASE_DIR, FILES_DIR, isName, isRefusal, isVersionName, mainFiles, NAME_MESSAGE, ORIGINAL, PATH_MESSAGE, parseVersionJson, refusal, safeFilePath, type StoreRefusal, VERSION_FILE, type VersionJson, writeVersionJson } from './custom-versions.js';
import { isInside } from './ide.js';
import { customRoot, type FileSet, HIVE_ORIGIN, itemDir, type ItemRef, type ItemSources, listFiles, originFiles, pluginVersion, resolveRef, versionDir, versionFiles } from './item-sources.js';
import { findItem } from './items-catalogue.js';
import type { CatalogueItem, ItemKind, ItemVersion } from './types.js';

export const MINE = 'mine';
export type StoreResult = { workspaces: string[] } | StoreRefusal;
type Target = Pick<ItemVersion, 'name' | 'workspaces'>;

export interface CustomStoreDeps {
  home: string;
  pluginSource: string;
  workspaces(): ItemSources['workspaces'];
  onChange(workspaces: string[]): void;
}
export interface CustomStore {
  saveFile(id: string, version: string | null, path: string, text: string, from?: string): Promise<StoreResult>;
  deleteFile(id: string, version: string, path: string): Promise<StoreResult>;
  createVersion(id: string, name: string, from: string): Promise<StoreResult>;
  renameVersion(id: string, version: string, name: string): Promise<StoreResult>;
  assign(id: string, workspace: string, version: string | null): Promise<StoreResult>;
  revert(id: string, version: string): Promise<StoreResult>;
  createItem(kind: ItemKind, name: string): Promise<StoreResult>;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );
const found = async (s: ItemSources, id: string): Promise<CatalogueItem | StoreRefusal> => (await findItem(s, id)) ?? refusal('unknown_item', `no item ${id}`);
const versionOf = (item: CatalogueItem, name: string): ItemVersion | StoreRefusal =>
  item.versions.find((v) => v.name === name) ?? refusal('unknown_version', `${item.id} has no version ${name}`);
const hiveVersionOf = async (s: ItemSources, ref: ItemRef): Promise<{ hiveVersion?: string }> => {
  const version = ref.origin === HIVE_ORIGIN ? await pluginVersion(s.pluginSource) : undefined;
  return version === undefined ? {} : { hiveVersion: version };
};

// The last guard before the disk: names and ids are checked already, and a folder outside <home>/custom/ is never written
function storeDir(s: ItemSources, ref: ItemRef, version: string): string {
  const dir = versionDir(s.home, ref, version);
  if (!isInside(customRoot(s.home), dir)) throw new Error(`${dir} is outside the custom store`);
  return dir;
}

async function copyAll({ dir, paths }: FileSet, to: string): Promise<void> {
  for (const path of paths) {
    await mkdir(dirname(join(to, path)), { recursive: true });
    await copyFile(join(dir, path), join(to, path));
  }
}

// version.json goes last: a folder without one is a half-made version, which the catalogue reports instead of using
async function writeVersion(dir: string, json: VersionJson, files: FileSet, base?: FileSet): Promise<void> {
  await copyAll(files, join(dir, FILES_DIR));
  if (base !== undefined) await copyAll(base, join(dir, BASE_DIR));
  await writeVersionJson(dir, json);
}

async function editVersionJson(dir: string, name: string, edit: (json: VersionJson) => VersionJson): Promise<void> {
  await writeVersionJson(dir, edit(parseVersionJson(await readFile(join(dir, VERSION_FILE), 'utf8'), name)));
}

// Saving the original: only while the item has no version, never on a user-created one. It becomes `mine`, used by every workspace that
// used the original
async function createMine(s: ItemSources, item: CatalogueItem): Promise<Target | StoreRefusal> {
  const dir = storeDir(s, item, MINE);
  if (item.userCreated || item.versions.length > 0 || (await exists(dir))) return refusal('original_locked', `${item.id}: the original is read-only once it has a version`);
  const origin = await originFiles(s, item);
  if (origin === undefined) return refusal('unknown_version', `${item.id} has no original`);
  const json: VersionJson = { name: MINE, from: ORIGINAL, workspaces: item.onOriginal, ...(await hiveVersionOf(s, item)) };
  await writeVersion(dir, json, origin, origin);
  return json;
}

async function saveFile(s: ItemSources, id: string, version: string | null, path: string, text: string, from?: string): Promise<StoreResult> {
  const file = safeFilePath(path);
  const old = from === undefined ? undefined : safeFilePath(from);
  if (file === undefined || (from !== undefined && (old === undefined || old === file))) return refusal('bad_path', PATH_MESSAGE);
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  const target = version === null ? await createMine(s, item) : versionOf(item, version);
  if (isRefusal(target)) return target;
  const files = join(storeDir(s, item, target.name), FILES_DIR);
  await mkdir(dirname(join(files, file)), { recursive: true });
  await writeFile(join(files, file), text);
  if (old !== undefined) await rm(join(files, old), { force: true }); // the .md → .md.liquid rename (#310)
  return { workspaces: target.workspaces };
}

async function deleteFile(s: ItemSources, id: string, version: string, path: string): Promise<StoreResult> {
  const file = safeFilePath(path);
  if (file === undefined) return refusal('bad_path', PATH_MESSAGE);
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  if (mainFiles(item.kind, item.name).includes(file)) return refusal('bad_path', `${file} is the ${item.kind}'s main file`);
  const target = versionOf(item, version);
  if (isRefusal(target)) return target;
  await rm(join(storeDir(s, item, version), FILES_DIR, file), { force: true });
  return { workspaces: target.workspaces };
}

// What a new version copies: the origin's files, which are also its base, or another version's files with that version's base
async function versionSource(s: ItemSources, item: CatalogueItem, from: string): Promise<{ files: FileSet; base?: FileSet; kept: { hiveVersion?: string } } | StoreRefusal> {
  if (from === ORIGINAL) {
    const origin = await originFiles(s, item);
    if (origin === undefined) return refusal('unknown_version', `${item.id} has no original`);
    return { files: origin, base: origin, kept: await hiveVersionOf(s, item) };
  }
  const source = versionOf(item, from);
  if (isRefusal(source)) return source;
  const baseDir = join(versionDir(s.home, item, from), BASE_DIR);
  const basePaths = await listFiles(baseDir);
  return {
    files: await versionFiles(s.home, item, from),
    ...(basePaths.length === 0 ? {} : { base: { dir: baseDir, paths: basePaths } }),
    kept: source.hiveVersion === undefined ? {} : { hiveVersion: source.hiveVersion },
  };
}

async function createVersion(s: ItemSources, id: string, name: string, from: string): Promise<StoreResult> {
  if (!isVersionName(name)) return refusal('bad_name', NAME_MESSAGE);
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  const dir = storeDir(s, item, name);
  if (await exists(dir)) return refusal('exists', `${id} already has a version ${name}`);
  const source = await versionSource(s, item, from);
  if (isRefusal(source)) return source;
  await writeVersion(dir, { name, from, workspaces: [], ...source.kept }, source.files, source.base);
  return { workspaces: [] };
}

async function renameVersion(s: ItemSources, id: string, version: string, name: string): Promise<StoreResult> {
  if (!isVersionName(name)) return refusal('bad_name', NAME_MESSAGE);
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  const target = versionOf(item, version);
  if (isRefusal(target)) return target;
  const to = storeDir(s, item, name);
  if (await exists(to)) return refusal('exists', `${id} already has a version ${name}`);
  await rename(storeDir(s, item, version), to);
  await editVersionJson(to, version, (json) => ({ ...json, name }));
  for (const other of item.versions.filter((v) => v.from === version)) {
    await editVersionJson(storeDir(s, item, other.name), other.name, (json) => ({ ...json, from: name }));
  }
  return { workspaces: target.workspaces };
}

// A workspace leaves every version of the item, then joins `version`; null sends it back to the original
async function assign(s: ItemSources, id: string, workspace: string, version: string | null): Promise<StoreResult> {
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  if (!s.workspaces.some((w) => w.name === workspace)) return refusal('unknown_workspace', `no workspace ${workspace}`);
  if (version === null && item.userCreated) return refusal('unknown_version', `${id} has no original`);
  const target = version === null ? undefined : versionOf(item, version);
  if (target !== undefined && isRefusal(target)) return target;
  for (const v of item.versions) {
    const isTarget = v.name === version;
    if (v.workspaces.includes(workspace) === isTarget) continue;
    await editVersionJson(storeDir(s, item, v.name), v.name, (json) => ({
      ...json,
      workspaces: isTarget ? [...json.workspaces, workspace] : json.workspaces.filter((w) => w !== workspace),
    }));
  }
  return { workspaces: [workspace] };
}

async function revert(s: ItemSources, id: string, version: string): Promise<StoreResult> {
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  const target = versionOf(item, version);
  if (isRefusal(target)) return target;
  await rm(storeDir(s, item, version), { recursive: true, force: true });
  // A user-created item has no original to fall back to: its last version takes the item with it
  if (item.userCreated && item.versions.length === 1) await rm(itemDir(s.home, item), { recursive: true, force: true });
  return { workspaces: target.workspaces };
}

async function createItem(s: ItemSources, kind: ItemKind, name: string): Promise<StoreResult> {
  if (!isName(name)) return refusal('bad_name', NAME_MESSAGE);
  const ref: ItemRef = { origin: HIVE_ORIGIN, kind, name };
  // One name per origin, across skills and specialists: the id has no kind to tell two items apart
  if ((await resolveRef(s, ref)) !== undefined || (await exists(itemDir(s.home, ref)))) return refusal('name_taken', `hive already has an item named ${name}`);
  const dir = storeDir(s, ref, MINE);
  const workspaces = s.workspaces.map((w) => w.name);
  await mkdir(join(dir, FILES_DIR), { recursive: true });
  await writeFile(join(dir, FILES_DIR, mainFiles(kind, name)[0] ?? name), `---\nname: ${name}\ndescription: ""\n---\n`);
  await writeVersionJson(dir, { name: MINE, from: null, workspaces });
  return { workspaces };
}

export function createCustomStore(deps: CustomStoreDeps): CustomStore {
  let chain: Promise<unknown> = Promise.resolve();
  // A failed write rejects its own caller only: the chain goes on with the next one
  function queued(job: (s: ItemSources) => Promise<StoreResult>): Promise<StoreResult> {
    const next = chain.then(async () => {
      const result = await job({ home: deps.home, pluginSource: deps.pluginSource, workspaces: deps.workspaces() });
      if (!isRefusal(result)) deps.onChange(result.workspaces);
      return result;
    });
    chain = next.catch(() => undefined);
    return next;
  }
  return {
    saveFile: (id, version, path, text, from) => queued((s) => saveFile(s, id, version, path, text, from)),
    deleteFile: (id, version, path) => queued((s) => deleteFile(s, id, version, path)),
    createVersion: (id, name, from) => queued((s) => createVersion(s, id, name, from)),
    renameVersion: (id, version, name) => queued((s) => renameVersion(s, id, version, name)),
    assign: (id, workspace, version) => queued((s) => assign(s, id, workspace, version)),
    revert: (id, version) => queued((s) => revert(s, id, version)),
    createItem: (kind, name) => queued((s) => createItem(s, kind, name)),
  };
}
