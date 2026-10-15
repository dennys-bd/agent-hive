// The catalogue (#315): every item the plugins view and the render read, from disk on every call, never cached across writes (#314).
// Shipped items, each workspace's main checkout's .claude/ items, and every folder under <home>/custom/.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE_DIR, mainFiles, parseVersionJson, refusal, type StoreRefusal, VERSION_FILE } from './custom-versions.js';
import { childFolders, type FileSet, HIVE_ORIGIN, itemDir, itemId, type ItemRef, type ItemSources, originDir, originFiles, originNames, parseItemId, resolveRef, sameFiles, versionDir, versionFiles } from './item-sources.js';
import { parseTemplate } from './template.js';
import type { CatalogueItem, ItemRead, ItemState, ItemVersion } from './types.js';

type Header = Pick<CatalogueItem, 'description' | 'basedOn' | 'error'>;
const NAME_TAKEN_MESSAGE = 'name taken by a skill';
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The main file's header through #310's parser. One that does not parse leaves the item listed with its error, so the user can fix it
function headerOf(text: string | undefined): Header {
  if (text === undefined) return { description: '' };
  const parsed = parseTemplate(text);
  const description = typeof parsed.header.description === 'string' ? parsed.header.description : '';
  const error = parsed.errors[0];
  return {
    description,
    ...(parsed.basedOn === undefined ? {} : { basedOn: parsed.basedOn }),
    ...(error === undefined ? {} : { error: { message: error.message, line: error.line } }),
  };
}

async function mainText(ref: ItemRef, files: FileSet): Promise<string | undefined> {
  const main = files.paths.find((path) => mainFiles(ref.kind, ref.name).includes(path));
  return main === undefined ? undefined : readFile(join(files.dir, main), 'utf8');
}

async function readVersion(sources: ItemSources, ref: ItemRef, folder: string, origin: FileSet | undefined): Promise<ItemVersion> {
  const dir = versionDir(sources.home, ref, folder);
  const text = await readFile(join(dir, VERSION_FILE), 'utf8').catch(() => {
    throw new Error(`version ${folder}: version.json cannot be read`);
  });
  const json = parseVersionJson(text, folder);
  const known = new Set(sources.workspaces.map((w) => w.name));
  return {
    name: json.name,
    from: json.from,
    workspaces: json.workspaces.filter((w) => known.has(w)),
    unknownWorkspaces: json.workspaces.filter((w) => !known.has(w)),
    updateAvailable: origin !== undefined && !(await sameFiles(origin, join(dir, BASE_DIR))),
    ...(json.hiveVersion === undefined ? {} : { hiveVersion: json.hiveVersion }),
  };
}

// The item's versions, sorted; a version.json that does not parse is left out and named in the item's error
async function readVersions(sources: ItemSources, ref: ItemRef, origin: FileSet | undefined): Promise<{ versions: ItemVersion[]; error?: string }> {
  const versions: ItemVersion[] = [];
  let error: string | undefined;
  for (const folder of await childFolders(itemDir(sources.home, ref))) {
    try {
      versions.push(await readVersion(sources, ref, folder, origin));
    } catch (err) {
      error ??= errorMessage(err);
    }
  }
  return error === undefined ? { versions } : { versions, error };
}

function stateOf(origin: string, versions: ItemVersion[]): ItemState {
  if (versions.some((v) => v.updateAvailable)) return 'update available';
  if (versions.length > 0) return 'customized';
  return origin === HIVE_ORIGIN ? 'original' : 'workspace';
}

// An item from its origin and its custom folder; undefined when neither holds it
async function readEntry(sources: ItemSources, ref: ItemRef): Promise<CatalogueItem | undefined> {
  const origin = await originFiles(sources, ref);
  const { versions, error: versionError } = await readVersions(sources, ref, origin);
  if (origin === undefined && versions.length === 0 && versionError === undefined) return undefined;
  const first = versions[0];
  const shown = origin ?? (first === undefined ? undefined : await versionFiles(sources.home, ref, first.name));
  const header = headerOf(shown && (await mainText(ref, shown)));
  const used = new Set(versions.flatMap((v) => v.workspaces));
  const users = origin === undefined ? [] : ref.origin === HIVE_ORIGIN ? sources.workspaces.map((w) => w.name) : [ref.origin];
  const error = header.error ?? (versionError === undefined ? undefined : { message: versionError });
  return {
    id: itemId(ref),
    ...ref,
    description: header.description,
    ...(header.basedOn === undefined ? {} : { basedOn: header.basedOn }),
    userCreated: ref.origin === HIVE_ORIGIN && origin === undefined,
    state: stateOf(ref.origin, versions),
    versions,
    onOriginal: users.filter((w) => !used.has(w)),
    files: shown?.paths ?? [],
    ...(error === undefined ? {} : { error }),
  };
}

// One name per origin (#315): a repository's specialist whose name its skill took is shown with the clash, never stored or delivered.
// It shares the skill's id, which addresses the skill
async function takenEntry(sources: ItemSources, ref: ItemRef): Promise<CatalogueItem> {
  const files = await originFiles(sources, ref);
  return {
    id: itemId(ref),
    ...ref,
    description: '',
    userCreated: false,
    state: stateOf(ref.origin, []),
    versions: [],
    onOriginal: [],
    files: files?.paths ?? [],
    error: { message: NAME_TAKEN_MESSAGE },
  };
}

async function originItems(sources: ItemSources, origin: string): Promise<CatalogueItem[]> {
  const [skills, specialists, stored] = await Promise.all([originNames(sources, origin, 'skill'), originNames(sources, origin, 'specialist'), childFolders(originDir(sources.home, origin))]);
  const names = [...new Set([...skills, ...specialists, ...stored])].sort((a, b) => a.localeCompare(b, 'en'));
  const items = await Promise.all(
    names.map(async (name): Promise<CatalogueItem[]> => {
      const ref = await resolveRef(sources, { origin, name });
      const entry = ref && (await readEntry(sources, ref));
      const taken = skills.includes(name) && specialists.includes(name) ? [await takenEntry(sources, { origin, kind: 'specialist', name })] : [];
      return [...(entry === undefined ? [] : [entry]), ...taken];
    }),
  );
  return items.flat();
}

/** Every item: `hive` first, then the workspaces in config order. */
export async function readCatalogue(sources: ItemSources): Promise<CatalogueItem[]> {
  // ponytail: a workspace named `hive` would share the Hive origin's ids and folders; its repository items are not listed
  const origins = [HIVE_ORIGIN, ...sources.workspaces.map((w) => w.name).filter((name) => name !== HIVE_ORIGIN)];
  return (await Promise.all(origins.map((origin) => originItems(sources, origin)))).flat();
}

/** One item by id; undefined for a malformed id, an origin the config does not have, or no such item. */
export async function findItem(sources: ItemSources, id: string): Promise<CatalogueItem | undefined> {
  const key = parseItemId(id);
  if (key === undefined || (key.origin !== HIVE_ORIGIN && !sources.workspaces.some((w) => w.name === key.origin))) return undefined;
  const ref = await resolveRef(sources, key);
  return ref && readEntry(sources, ref);
}

/** An item with the files of its original (version null) or of one version. */
export async function readItem(sources: ItemSources, id: string, version: string | null): Promise<ItemRead | StoreRefusal> {
  const item = await findItem(sources, id);
  if (item === undefined) return refusal('unknown_item', `no item ${id}`);
  const files = version === null ? await originFiles(sources, item) : item.versions.some((v) => v.name === version) ? await versionFiles(sources.home, item, version) : undefined;
  if (files === undefined) return refusal('unknown_version', version === null ? `${id} has no original` : `${id} has no version ${version}`);
  const read = await Promise.all(files.paths.map(async (path) => ({ path, text: await readFile(join(files.dir, path), 'utf8') })));
  return { item, version, files: read };
}
