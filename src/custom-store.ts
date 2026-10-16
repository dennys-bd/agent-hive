// The custom store (#315): the user's versions and items under <home>/custom/<origin>/<name>/<version>/. One promise chain per
// store, so two quick clicks never interleave; every write answers the workspaces it affects, or a refusal, and tells onChange (#316's
// render) only after a write that happened. The Hive never writes to the shipped plugin; in a workspace's repository it only creates a new
// item's stub under `.claude/` (#313) and never commits it.
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyUpdate, recoverStaging, type UpdateChoices } from './custom-merge.js';
import { BASE_DIR, FILES_DIR, isName, isRefusal, isVersionName, mainFiles, NAME_MESSAGE, ORIGINAL, PATH_MESSAGE, parseVersionJson, refusal, safeFilePath, type StoreRefusal, VERSION_FILE, type VersionJson, writeVersionJson } from './custom-versions.js';
import { isInside } from './ide.js';
import { customRoot, type FileSet, HIVE_ORIGIN, itemDir, type ItemRef, type ItemSources, listFiles, originFiles, pluginVersion, resolveRef, versionDir, versionFiles } from './item-sources.js';
import { findItem } from './items-catalogue.js';
import type { Logger } from './log.js';
import type { CatalogueItem, ItemKind, ItemVersion } from './types.js';

export const MINE = 'mine';
export type StoreResult = { workspaces: string[] } | StoreRefusal;
type Target = Pick<ItemVersion, 'name' | 'workspaces'>;

export interface CustomStoreDeps {
  home: string;
  pluginSource: string;
  workspaces(): ItemSources['workspaces'];
  onChange(workspaces: string[]): void;
  log: Pick<Logger, 'error'>;
}
export interface CustomStore {
  saveFile(id: string, version: string | null, path: string, text: string, from?: string): Promise<StoreResult>;
  deleteFile(id: string, version: string, path: string): Promise<StoreResult>;
  createVersion(id: string, name: string, from: string): Promise<StoreResult>;
  renameVersion(id: string, version: string, name: string): Promise<StoreResult>;
  assign(id: string, workspace: string, version: string | null): Promise<StoreResult>;
  revert(id: string, version: string): Promise<StoreResult>;
  createItem(kind: ItemKind, name: string, origin?: string): Promise<StoreResult>;
  applyUpdate(id: string, version: string, token: string, choices: UpdateChoices): Promise<StoreResult>;
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
  try {
    await copyAll(files, join(dir, FILES_DIR));
    if (base !== undefined) await copyAll(base, join(dir, BASE_DIR));
    await writeVersionJson(dir, json);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

// A target that is a folder, or sits behind a file, is the caller's bad path, not a server fault
const PATH_ERRORS = new Set(['EISDIR', 'ERR_FS_EISDIR', 'ENOTDIR', 'ENOENT', 'EEXIST']);
async function orBadPath<T>(job: () => Promise<T>): Promise<T | StoreRefusal> {
  try {
    return await job();
  } catch (err) {
    if (PATH_ERRORS.has((err as NodeJS.ErrnoException).code ?? '')) return refusal('bad_path', PATH_MESSAGE);
    throw err;
  }
}

// Case-insensitive disks resolve SKILL.md and skill.md to one file
const isMainFile = (item: CatalogueItem, file: string): boolean => mainFiles(item.kind, item.name).some((m) => m.toLowerCase() === file.toLowerCase());

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
  if (file === undefined || (from !== undefined && (old === undefined || old.toLowerCase() === file.toLowerCase()))) return refusal('bad_path', PATH_MESSAGE); // APFS: a case-only rename is one file, the rm would delete it
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  const target = version === null ? await createMine(s, item) : versionOf(item, version);
  if (isRefusal(target)) return target;
  // A rename never turns the main file into another file or another file into the main one
  if (old !== undefined && isMainFile(item, old) !== isMainFile(item, file)) return refusal('bad_path', PATH_MESSAGE);
  const files = join(storeDir(s, item, target.name), FILES_DIR);
  const failed = await orBadPath(async () => {
    await mkdir(dirname(join(files, file)), { recursive: true });
    await writeFile(join(files, file), text);
    if (old !== undefined) await rm(join(files, old), { force: true }); // the .md → .md.liquid rename (#310)
  });
  return failed ?? { workspaces: target.workspaces };
}

async function deleteFile(s: ItemSources, id: string, version: string, path: string): Promise<StoreResult> {
  const file = safeFilePath(path);
  if (file === undefined) return refusal('bad_path', PATH_MESSAGE);
  const item = await found(s, id);
  if (isRefusal(item)) return item;
  if (isMainFile(item, file)) return refusal('bad_path', `${file} is the ${item.kind}'s main file`);
  const target = versionOf(item, version);
  if (isRefusal(target)) return target;
  const failed = await orBadPath(() => rm(join(storeDir(s, item, version), FILES_DIR, file), { force: true }));
  return failed ?? { workspaces: target.workspaces };
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
  const from = storeDir(s, item, version);
  await rename(from, to);
  try {
    await editVersionJson(to, version, (json) => ({ ...json, name }));
  } catch (err) {
    await rename(to, from); // the folder's name and its version.json must agree
    throw err;
  }
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
  const isLast = item.userCreated && item.versions.length === 1;
  if (item.userCreated && !isLast && target.workspaces.length > 0) return refusal('in_use', `${id}: assign its workspaces to another version first`);
  // Re-parent first: a failed edit then leaves the version in place instead of children pointing at nothing
  for (const other of item.versions.filter((v) => v.from === version)) {
    await editVersionJson(storeDir(s, item, other.name), other.name, (json) => ({ ...json, from: target.from }));
  }
  await rm(storeDir(s, item, version), { recursive: true, force: true });
  // A user-created item has no original to fall back to: its last version takes the item with it
  if (isLast) await rm(itemDir(s.home, item), { recursive: true, force: true });
  return { workspaces: target.workspaces };
}

// The header every new item starts with, on either side
const stubOf = (name: string): string => `---\nname: ${name}\ndescription: ""\n---\n`;

async function createItem(s: ItemSources, kind: ItemKind, name: string): Promise<StoreResult> {
  if (!isName(name)) return refusal('bad_name', NAME_MESSAGE);
  const ref: ItemRef = { origin: HIVE_ORIGIN, kind, name };
  // One name per origin, across skills and specialists: the id has no kind to tell two items apart
  if ((await resolveRef(s, ref)) !== undefined || (await exists(itemDir(s.home, ref)))) return refusal('name_taken', `hive already has an item named ${name}`);
  const dir = storeDir(s, ref, MINE);
  const workspaces = s.workspaces.map((w) => w.name);
  await mkdir(join(dir, FILES_DIR), { recursive: true });
  await writeFile(join(dir, FILES_DIR, mainFiles(kind, name)[0] ?? name), stubOf(name));
  await writeVersionJson(dir, { name: MINE, from: null, workspaces });
  return { workspaces };
}

// A workspace's own item (#313): its stub in the main checkout's .claude/, as Claude Code lays it out. The same name rule and the same last
// guard as the store's writes: nothing outside .claude/
async function createWorkspaceItem(s: ItemSources, kind: ItemKind, name: string, origin: string): Promise<StoreResult> {
  if (!isName(name)) return refusal('bad_name', NAME_MESSAGE);
  const workspace = s.workspaces.find((w) => w.name === origin);
  if (workspace === undefined) return refusal('unknown_workspace', `no workspace ${origin}`);
  const root = join(workspace.path, '.claude');
  const file = kind === 'skill' ? join(root, 'skills', name, 'SKILL.md') : join(root, 'agents', `${name}.md`);
  if (!isInside(root, file)) throw new Error(`${file} is outside ${root}`);
  const ref: ItemRef = { origin, kind, name };
  // One name per origin, across kinds; a skill folder with no SKILL.md yet still holds its name on disk
  const isTaken = (await resolveRef(s, ref)) !== undefined || (await exists(itemDir(s.home, ref))) || (kind === 'skill' && (await exists(dirname(file))));
  if (isTaken) return refusal('name_taken', `${origin} already has an item named ${name}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stubOf(name), { flag: 'wx' }); // wx: a file that appeared since the check is never overwritten
  return { workspaces: [origin] };
}

export function createCustomStore(deps: CustomStoreDeps): CustomStore {
  // A crash between an update's two renames left the version in the staging area: it goes back before any read or write is queued
  let chain: Promise<unknown> = recoverStaging(deps.home).catch((err: unknown) => {
    deps.log.error(`custom store: staging recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // The write already happened: a render that fails is logged, never turned into a failed write
  function notify(workspaces: string[]): void {
    try {
      deps.onChange(workspaces);
    } catch (err) {
      deps.log.error(`custom store: onChange failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A failed write rejects its own caller only: the chain goes on with the next one
  function queued(job: (s: ItemSources) => Promise<StoreResult>): Promise<StoreResult> {
    const next = chain.then(async () => {
      const result = await job({ home: deps.home, pluginSource: deps.pluginSource, workspaces: deps.workspaces() });
      if (!isRefusal(result)) notify(result.workspaces);
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
    createItem: (kind, name, origin) => queued((s) => (origin === undefined || origin === HIVE_ORIGIN ? createItem(s, kind, name) : createWorkspaceItem(s, kind, name, origin))),
    // Queued like a save, so an apply never interleaves with one, and onChange re-renders the version's workspaces after it (#324)
    applyUpdate: (id, version, token, choices) => queued((s) => applyUpdate(s, id, version, token, choices)),
  };
}
