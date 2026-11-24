// The boot migration of #621 (decisions 7 to 10): a config with a workspace from before `variables` gets that workspace's values from the
// templates of the versions it uses in the custom store. The config is written first; then the moved values leave those templates, and a
// version left byte for byte equal to the shipped files it was made from goes back to the Hive's original for that workspace. Not in
// config-migrate.ts, which is pure over raw JSON: this one reads and writes the disk. A checkout's .claude/ item is never read or written.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILE } from './config.js';
import { BASE_DIR, ORIGINAL, parseVersionJson, VERSION_FILE, writeVersionJson } from './custom-versions.js';
import { type FileSet, HIVE_ORIGIN, type ItemSources, originFiles, sameFiles, versionDir, versionFiles } from './item-sources.js';
import { readCatalogue } from './items-catalogue.js';
import type { Logger } from './log.js';
import { replaceFile } from './replace-file.js';
import { parseTemplate, type TemplateVariable } from './template.js';
import { setVariableValue } from './template-edit.js';
import type { CatalogueItem, VariableValue } from './types.js';

export interface VariablesMigrationDeps {
  home: string;
  pluginSource: string; // the shipped plugin, whose originals the catalogue lists
  log: Pick<Logger, 'info' | 'error'>;
}

type Values = Record<string, VariableValue>;
interface RawWorkspace { name: string; path: string; hasVariables: boolean }
// One template file of an item as one workspace receives it: its version's, or the shipped original's when it uses none (read for the log only)
interface Template {
  workspace: string;
  item: CatalogueItem;
  version: string | undefined; // undefined: the Hive's original, never edited
  path: string; // under the item's files
  file: string;
  text: string;
  variables: TemplateVariable[];
}

const TEMPLATE_FILE = /\.md(?:\.liquid)?$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// The class only: an fs error's message holds the home's path
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
const label = (t: Template): string => `${t.item.name}/${t.path}`;
const versionKey = (t: Template): string => `${t.item.id}\0${t.version ?? ''}`;
// Code-unit order, so a tie (decision 8) goes the same way on every machine
const byId = (a: CatalogueItem, b: CatalogueItem): number => Number(a.id > b.id) - Number(a.id < b.id);

// The config's workspaces as the catalogue reads them; one with no name or path is the parse's to refuse
function rawWorkspaces(raw: unknown): RawWorkspace[] {
  const comb = isRecord(raw) ? raw.comb : undefined;
  const list: unknown[] = isRecord(comb) && Array.isArray(comb.workspaces) ? comb.workspaces : [];
  return list.flatMap((w) => (isRecord(w) && typeof w.name === 'string' && typeof w.path === 'string' ? [{ name: w.name, path: w.path, hasVariables: Object.hasOwn(w, 'variables') }] : []));
}

// One item's templates for `workspace`. A file that cannot be read, or one that does not parse, leaves the whole version as it is (decision
// 10): a workspace's value is never taken from half a version
async function itemTemplates(sources: ItemSources, item: CatalogueItem, workspace: string, log: VariablesMigrationDeps['log']): Promise<Template[]> {
  const version = item.versions.find((v) => v.workspaces.includes(workspace))?.name;
  const where = version === undefined ? item.name : `${item.name} version ${version}`;
  let read: { path: string; file: string; text: string }[];
  try {
    const files: FileSet | undefined = version === undefined ? await originFiles(sources, item) : await versionFiles(sources.home, item, version);
    const dir = files?.dir ?? '';
    read = await Promise.all((files?.paths ?? []).filter((p) => TEMPLATE_FILE.test(p)).map(async (path) => ({ path, file: join(dir, path), text: await readFile(join(dir, path), 'utf8') })));
  } catch (err) {
    log.error(`variables migration: ${where} for ${workspace} not read (${errorName(err)}); left as it is`);
    return [];
  }
  const parsed = read.map((r) => ({ ...r, parsed: parseTemplate(r.text) }));
  const broken = parsed.find((p) => p.parsed.errors.length > 0);
  if (broken !== undefined) {
    const [first] = broken.parsed.errors;
    log.error(`variables migration: ${item.name}/${broken.path} for ${workspace} does not parse (line ${first?.line}); ${where} is left as it is`);
    return [];
  }
  return parsed.map((p) => ({ workspace, item, version, path: p.path, file: p.file, text: p.text, variables: p.parsed.variables }));
}

// Every Hive item's templates for each workspace being migrated, in catalogue order: by item id, then file path (listFiles sorts)
async function readTemplates(sources: ItemSources, pending: readonly string[], log: VariablesMigrationDeps['log']): Promise<Template[]> {
  let items: CatalogueItem[];
  try {
    items = (await readCatalogue(sources)).filter((item) => item.origin === HIVE_ORIGIN).sort(byId);
  } catch (err) {
    log.error(`variables migration: the catalogue could not be read (${errorName(err)}); every workspace starts with no value and its templates keep theirs`);
    return [];
  }
  const read: Template[] = [];
  for (const workspace of pending) for (const item of items) read.push(...(await itemTemplates(sources, item, workspace, log)));
  return read;
}

// The first of the most frequent values: the values come in catalogue order, so a tie takes the first item's (decision 8)
const mostCommon = (values: readonly VariableValue[]): VariableValue => {
  const counts = values.map((value) => values.filter((other) => other === value).length);
  return values[counts.indexOf(Math.max(...counts))];
};

// Decision 8: per name, the value most of the workspace's versioned templates hold for it
function chooseValues(templates: readonly Template[]): Values {
  const held = templates
    .filter((t) => t.version !== undefined)
    .flatMap((t) => t.variables.filter((v) => Object.hasOwn(v.workspaces, t.workspace)).map((v) => ({ name: v.name, value: v.workspaces[t.workspace] })));
  const names = [...new Set(held.map((h) => h.name))];
  return Object.fromEntries(names.map((name) => [name, mostCommon(held.filter((h) => h.name === name).map((h) => h.value))]));
}

// The raw config with each pending workspace's variables; every other key and workspace as read
function withVariables(raw: unknown, moved: Readonly<Record<string, Values>>): unknown {
  if (!isRecord(raw) || !isRecord(raw.comb) || !Array.isArray(raw.comb.workspaces)) return raw;
  const workspaces = raw.comb.workspaces.map((w: unknown) =>
    (isRecord(w) && !Object.hasOwn(w, 'variables') && typeof w.name === 'string' && Object.hasOwn(moved, w.name) ? { ...w, variables: moved[w.name] } : w));
  return { ...raw, comb: { ...raw.comb, workspaces } };
}

// Temp + rename, as POST /settings writes the file: a reader never sees half of it
async function writeAtomic(path: string, text: string): Promise<void> {
  await writeFile(`${path}.tmp`, text);
  await replaceFile(`${path}.tmp`, path);
}

// Decisions 8 and 8a for one template and its workspace: an entry equal to the moved value goes, a divergent one stays as the override, and
// a declaration with no entry now renders the workspace's value, which the log names. A variable from the task reads no workspace value
function stripOne(text: string, t: Template, values: Values, log: VariablesMigrationDeps['log']): string {
  let next = text;
  for (const { name, workspaces, from } of t.variables) {
    if (from !== undefined || !Object.hasOwn(values, name)) continue;
    if (!Object.hasOwn(workspaces, t.workspace)) {
      log.info(`${label(t)} now renders the workspace's ${name} for ${t.workspace}`);
      continue;
    }
    if (t.version === undefined) continue; // an original is never edited
    if (workspaces[t.workspace] !== values[name]) {
      log.info(`kept ${name} of ${t.workspace} as an override in ${label(t)}`);
      continue;
    }
    const edited = setVariableValue(next, name, t.workspace, undefined);
    if (edited.ok) next = edited.text;
  }
  return next;
}

// Every template file rewritten once, whichever workspaces it serves; the versions with a file that was not written are answered, and keep
// their workspaces (decision 10). ponytail: a version of several files can keep the ones written before the failure; one file per item ships today
async function stripAll(read: readonly Template[], moved: Readonly<Record<string, Values>>, log: VariablesMigrationDeps['log']): Promise<Set<string>> {
  const texts = new Map<string, { original: string; text: string; template: Template }>();
  for (const t of read) {
    const current = texts.get(t.file);
    texts.set(t.file, { original: t.text, text: stripOne(current?.text ?? t.text, t, moved[t.workspace] ?? {}, log), template: t });
  }
  const failed = new Set<string>();
  for (const [file, { original, text, template }] of texts) {
    if (text === original) continue;
    await writeAtomic(file, text).catch((err: unknown) => {
      log.error(`variables migration: ${label(template)} not written (${errorName(err)}); its version keeps its workspaces`);
      failed.add(versionKey(template));
    });
  }
  return failed;
}

// Decision 9: a version made from the original whose files are now its base's, byte for byte, leaves the workspaces it was read for. It stays
// in the store, so assigning it again undoes the reset
async function resetOne(home: string, item: CatalogueItem, version: string, workspaces: readonly string[], log: VariablesMigrationDeps['log']): Promise<void> {
  if (item.versions.find((v) => v.name === version)?.from !== ORIGINAL) return;
  try {
    const dir = versionDir(home, item, version);
    if (!(await sameFiles(await versionFiles(home, item, version), join(dir, BASE_DIR)))) return;
    const json = parseVersionJson(await readFile(join(dir, VERSION_FILE), 'utf8'), version);
    await writeVersionJson(dir, { ...json, workspaces: json.workspaces.filter((w) => !workspaces.includes(w)) });
    for (const workspace of workspaces) log.info(`${item.name} back on the Hive's original for ${workspace}`);
  } catch (err) {
    log.error(`variables migration: ${item.name} version ${version} not reset (${errorName(err)}); it keeps its workspaces`);
  }
}

async function resetVersions(home: string, read: readonly Template[], failed: ReadonlySet<string>, log: VariablesMigrationDeps['log']): Promise<void> {
  const versions = new Map<string, { item: CatalogueItem; version: string; workspaces: string[] }>();
  for (const t of read) {
    if (t.version === undefined || failed.has(versionKey(t))) continue;
    const seen = versions.get(versionKey(t))?.workspaces ?? [];
    versions.set(versionKey(t), { item: t.item, version: t.version, workspaces: seen.includes(t.workspace) ? seen : [...seen, t.workspace] });
  }
  for (const { item, version, workspaces } of versions.values()) await resetOne(home, item, version, workspaces, log);
}

/** Decision 7: `raw` with `variables` on every workspace that lacked the key, written to hive.config.json before any template is touched;
 * `raw` itself when none lacks it. Never throws: what it cannot read or write is logged, and the parse that follows names anything else. */
export async function migrateWorkspaceVariables(raw: unknown, deps: VariablesMigrationDeps): Promise<unknown> {
  const workspaces = rawWorkspaces(raw);
  const pending = workspaces.filter((w) => !w.hasVariables).map((w) => w.name);
  if (pending.length === 0) return raw;
  const sources: ItemSources = { home: deps.home, pluginSource: deps.pluginSource, workspaces };
  const read = await readTemplates(sources, pending, deps.log);
  const moved = Object.fromEntries(pending.map((w) => [w, chooseValues(read.filter((t) => t.workspace === w))]));
  const next = withVariables(raw, moved);
  try {
    await writeAtomic(join(deps.home, CONFIG_FILE), `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    // the templates keep their values, which render the same as overrides (decision 3), and the next boot migrates again
    deps.log.error(`variables migration: ${CONFIG_FILE} not written (${errorName(err)}); the templates keep their values`);
    return next;
  }
  for (const [workspace, values] of Object.entries(moved)) {
    for (const [name, value] of Object.entries(values)) deps.log.info(`migrated variable ${name} of ${workspace} to the workspace: ${String(value)}`);
  }
  await resetVersions(deps.home, read, await stripAll(read, moved, deps.log), deps.log);
  return next;
}
