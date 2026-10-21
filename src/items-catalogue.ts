// The catalogue (#315): every item the plugins view and the render read, from disk on every call, never cached across writes (#314).
// Shipped items, each workspace's main checkout's .claude/ items, and every folder under <home>/custom/.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE_DIR, mainFiles, parseVersionJson, refusal, type StoreRefusal, VERSION_FILE } from './custom-versions.js';
import { childFolders, type FileSet, HIVE_ORIGIN, itemDir, itemId, type ItemRef, type ItemSources, listFiles, originDir, originFiles, originNames, parseItemId, resolveRef, sameFiles, versionDir, versionFiles } from './item-sources.js';
import { agentPrompt } from './stage-agent.js';
import { parseTemplate } from './template.js';
import type { LintItem } from './template-lint.js';
import { templateRefs } from './template-refs.js';
import type { CatalogueItem, ItemRead, ItemState, ItemUsage, ItemVersion, LintInputRead, Stage } from './types.js';

type Header = Pick<CatalogueItem, 'description' | 'basedOn' | 'error'>;
const NAME_TAKEN_MESSAGE = 'name taken by a skill';
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type StageRef = Pick<Stage, 'name' | 'prompt' | 'action' | 'skill'>; // #710: what agentPrompt reads
type UsageTarget = Pick<CatalogueItem, 'id' | 'origin' | 'kind' | 'name'>;
// An item with its main file's text, what usageOf scans; '' for an item with no main file
interface Entry { item: CatalogueItem; text: string }

const NAME_END = '(?![\\w-])'; // new-build is not new-build-fast
// Repository names are listed as the disk has them (originNames), so a name is escaped before it becomes a pattern
const escapeName = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What runs a skill as a stage: `/hive:<name>` for the Hive's, `/<name>` for a repository's, never inside a path or a URL. A specialist is
// never a stage's command. A stage prompt is plain prose, not a template, so it is not read through templateRefs
function stagePattern(item: UsageTarget): RegExp | undefined {
  if (item.kind !== 'skill') return undefined;
  const command = item.origin === HIVE_ORIGIN ? `hive:${escapeName(item.name)}` : escapeName(item.name);
  return new RegExp(`(?<![\\w./:-])/${command}${NAME_END}`);
}

// Whether a reference of src/template-refs.ts (the one definition of a reference, shared with the lint) names the item. Hive items are named
// by `hive:<name>` (a skill also by `/<name>`); a repository's skill by `/<name>`. A repository's specialist has no namespace, so nothing names it.
// ponytail: a bare `/name` counts only inside inline code, as templateRefs reads it; prose is not scanned
const names = (item: UsageTarget, ref: { kind: string; name: string }): boolean => {
  if (ref.name !== item.name) return false;
  if (item.origin === HIVE_ORIGIN) return ref.kind === 'hive' || (ref.kind === 'bare' && item.kind === 'skill');
  return ref.kind === 'bare' && item.kind === 'skill';
};

/** Each item's usage (#313), aligned with `items`: the stages whose prompt or skill runs it, in config order, then every other item whose main text
 * (texts[i] is items[i]'s) names it, in catalogue order. An item sharing an id (a name clash) is never its own caller.
 * ponytail: every text is parsed once and tested against every item, O(n²); a catalogue is tens of items. */
export function usageOf(items: readonly UsageTarget[], texts: readonly string[], stages: readonly StageRef[]): ItemUsage[][] {
  const refs = texts.map((text) => (text === '' ? [] : templateRefs(parseTemplate(text))));
  return items.map((item) => {
    const stage = stagePattern(item);
    // #710: a stage runs what agentPrompt answers: its prompt, or /hive:<skill> on a skill stage
    const ran = stage === undefined ? [] : stages.filter((s) => stage.test(agentPrompt(s) ?? '')).map((s): ItemUsage => ({ kind: 'stage', stage: s.name }));
    const callers = items.filter((other, i) => other.id !== item.id && (refs[i] ?? []).some((ref) => names(item, ref)));
    return [...ran, ...callers.map((c): ItemUsage => ({ kind: 'caller', id: c.id }))];
  });
}

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

// #320, decision 6: the newest mtime among the version's own files; base/ and version.json are the store's bookkeeping, not the user's edits.
// ponytail: a version with no file answers its folder's mtime (Math.max of nothing throws); the store never leaves files/ empty
async function versionEditedAt(sources: ItemSources, ref: ItemRef, folder: string): Promise<string> {
  const files = await versionFiles(sources.home, ref, folder);
  const times = await Promise.all(files.paths.map(async (path) => (await stat(join(files.dir, path)).catch(() => ({ mtimeMs: 0 }))).mtimeMs)); // gone since the listing: the catalogue still reads
  const newest = times.length > 0 ? Math.max(...times) : (await stat(versionDir(sources.home, ref, folder))).mtimeMs;
  return new Date(newest).toISOString();
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
    editedAt: await versionEditedAt(sources, ref, folder),
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
async function readEntry(sources: ItemSources, ref: ItemRef): Promise<Entry | undefined> {
  const origin = await originFiles(sources, ref);
  const { versions, error: versionError } = await readVersions(sources, ref, origin);
  if (origin === undefined && versions.length === 0 && versionError === undefined) return undefined;
  const first = versions[0];
  const shown = origin ?? (first === undefined ? undefined : await versionFiles(sources.home, ref, first.name));
  const text = shown && (await mainText(ref, shown));
  const header = headerOf(text);
  const used = new Set(versions.flatMap((v) => v.workspaces));
  const users = origin === undefined ? [] : ref.origin === HIVE_ORIGIN ? sources.workspaces.map((w) => w.name) : [ref.origin];
  const error = header.error ?? (versionError === undefined ? undefined : { message: versionError });
  const item: CatalogueItem = {
    id: itemId(ref),
    ...ref,
    description: header.description,
    ...(header.basedOn === undefined ? {} : { basedOn: header.basedOn }),
    userCreated: ref.origin === HIVE_ORIGIN && origin === undefined,
    state: stateOf(ref.origin, versions),
    versions,
    onOriginal: users.filter((w) => !used.has(w)),
    files: shown?.paths ?? [],
    usage: [], // readCatalogue fills it: usage needs every item's text
    ...(error === undefined ? {} : { error }),
  };
  return { item, text: text ?? '' };
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
    usage: [],
    error: { message: NAME_TAKEN_MESSAGE },
  };
}

async function originItems(sources: ItemSources, origin: string): Promise<Entry[]> {
  const [skills, specialists, stored] = await Promise.all([originNames(sources, origin, 'skill'), originNames(sources, origin, 'specialist'), childFolders(originDir(sources.home, origin))]);
  const names = [...new Set([...skills, ...specialists, ...stored])].sort((a, b) => a.localeCompare(b, 'en'));
  const items = await Promise.all(
    names.map(async (name): Promise<Entry[]> => {
      const ref = await resolveRef(sources, { origin, name });
      const entry = ref && (await readEntry(sources, ref));
      const taken = skills.includes(name) && specialists.includes(name) ? [await takenEntry(sources, { origin, kind: 'specialist', name })] : [];
      return [...(entry === undefined ? [] : [entry]), ...taken.map((item): Entry => ({ item, text: '' }))];
    }),
  );
  return items.flat();
}

// hive first, then the workspaces in config order: what every whole-catalogue read walks.
// ponytail: a workspace named `hive` would share the Hive origin's ids and folders; its repository items are not listed
const originsOf = (sources: ItemSources): string[] => [HIVE_ORIGIN, ...sources.workspaces.map((w) => w.name).filter((name) => name !== HIVE_ORIGIN)];

/** Every item: `hive` first, then the workspaces in config order, each with its usage (#313) from `stages` and the items' texts. */
export async function readCatalogue(sources: ItemSources, stages: readonly StageRef[] = []): Promise<CatalogueItem[]> {
  const entries = (await Promise.all(originsOf(sources).map((origin) => originItems(sources, origin)))).flat();
  const usage = usageOf(entries.map((e) => e.item), entries.map((e) => e.text), stages);
  return entries.map((e, i) => ({ ...e.item, usage: usage[i] ?? [] }));
}

/** One item by id, its usage [] (only the whole catalogue knows who names it); undefined for a malformed id, an origin the config does not
 * have, or no such item. */
export async function findItem(sources: ItemSources, id: string): Promise<CatalogueItem | undefined> {
  const key = parseItemId(id);
  if (key === undefined || (key.origin !== HIVE_ORIGIN && !sources.workspaces.some((w) => w.name === key.origin))) return undefined;
  const ref = await resolveRef(sources, key);
  return ref && (await readEntry(sources, ref))?.item;
}

/** An item with the files of its original (version null) or of one version. */
export async function readItem(sources: ItemSources, id: string, version: string | null): Promise<ItemRead | StoreRefusal> {
  const item = await findItem(sources, id);
  if (item === undefined) return refusal('unknown_item', `no item ${id}`);
  const files = version === null ? await originFiles(sources, item) : item.versions.some((v) => v.name === version) ? await versionFiles(sources.home, item, version) : undefined;
  if (files === undefined) return refusal('unknown_version', version === null ? `${id} has no original` : `${id} has no version ${version}`);
  // #319: the editor's "saved 14:31" reads a file's mtime; the shipped original was never saved by the user, so it answers none
  const isStamped = version !== null || item.origin !== HIVE_ORIGIN;
  const read = await Promise.all(files.paths.map(async (path) => {
    const file = join(files.dir, path);
    const text = await readFile(file, 'utf8');
    return isStamped ? { path, text, savedAt: (await stat(file)).mtime.toISOString() } : { path, text };
  }));
  return { item, version, files: read };
}

/** The editor lint's input beside the open file (#327): every Hive item with the variables its main file declares (the original's, or a
 * user-created item's first version's: the files `CatalogueItem.files` lists), every workspace skill with none, so a reference to it resolves,
 * and the plugin's scripts as a reference names them (`scripts/<file>`). */
export async function readLintInput(sources: ItemSources): Promise<LintInputRead> {
  const entries = (await Promise.all(originsOf(sources).map((origin) => originItems(sources, origin)))).flat();
  const catalogue = entries
    .filter(({ item }) => item.origin === HIVE_ORIGIN || item.kind === 'skill')
    .map(({ item, text }): LintItem => ({ origin: item.origin, kind: item.kind, name: item.name, variables: item.origin === HIVE_ORIGIN ? parseTemplate(text).variables : [] }));
  const scripts = await listFiles(join(sources.pluginSource, 'scripts'));
  return { catalogue, scripts: scripts.map((file) => `scripts/${file}`) };
}
