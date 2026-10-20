// Each workspace's plugin (#316): <home>/plugins/<workspace>/, the shipped plugin overlaid with the version of each Hive item the workspace uses
// and with the user's own Hive items, every .liquid file rendered with the workspace's values. Every agent run of the workspace loads it, and no
// run loads anything else (#317): a shipped skill is a template, loadable only once rendered. Shaped like worker-lsp.ts: one queued writer,
// dir() with no I/O, and ready() for the launches to wait on.
import { readdirSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCodexWorkspace, removeCodexWorkspace } from './agents/codex-home.js';
import { mainFiles } from './custom-versions.js';
import { HIVE_ORIGIN, listFiles, versionFiles } from './item-sources.js';
import { readCatalogue } from './items-catalogue.js';
import type { Logger } from './log.js';
import { deliveredHeader, deliveredName, hasDeclarations, type ParsedTemplate, parseTemplate, type RenderResult, renderTemplate } from './template.js';
import type { CatalogueItem, Workspace } from './types.js';

export const PLUGINS_DIR = 'plugins'; // <home>/plugins/<workspace>
const DIR_MODE = 0o700; // under the home, this user's only
const TMP_PREFIX = '.tmp-';
const OLD_PREFIX = '.old-';
const LIQUID_SUFFIX = '.liquid';
const MD_SUFFIX = '.md';
const GONE = { recursive: true, force: true } as const;

/** What a write reads of the config: each workspace's name, and its checkout for the catalogue. Config satisfies it. */
export interface RenderConfig {
  comb: { workspaces: readonly Pick<Workspace, 'name' | 'path'>[] };
}

export interface PluginRenderDeps {
  home: string;
  pluginSource: string; // assets/plugin
  log: Pick<Logger, 'error'>;
  env?: NodeJS.ProcessEnv; // CODEX_HOME; a test passes its own
}
/** dir()'s refusal (#317): the workspace has no plugin folder, since the config does not have it or every write of it failed. Its message names
 * the workspace only, never a path. */
export class NoPluginFolderError extends Error {
  constructor(workspace: string) {
    super(`workspace ${workspace} has no plugin folder`);
    this.name = 'NoPluginFolderError';
  }
}

export interface PluginRender {
  write(config: RenderConfig, only?: readonly string[]): Promise<void>; // queued, never rejects; `only` limits it to those workspaces and skips the sweep
  dir(workspace: string): string; // <home>/plugins/<ws> once a write or an earlier boot left it, else NoPluginFolderError; no I/O
  ready(): Promise<void>; // settles when every write queued so far has
}

/** A workspace's folder, its name encoded as its protocol folder's is. No I/O. Throws for a name that would leave <home>/plugins or take a dot
 * entry's place (.codex, .tmp-*, .old-*): the config's name rule already refuses both, but this path is also what a write removes. */
export function pluginRenderPath(home: string, workspace: string): string {
  const name = encodeURIComponent(workspace);
  if (name === '' || name.startsWith('.')) throw new Error('workspace name outside the plugins folder');
  return join(home, PLUGINS_DIR, name);
}

// The class only: an fs error's message holds the home's path
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

// A folder entry's workspace; undefined for a dot entry or a name no workspace encodes to
function workspaceOf(entry: string): string | undefined {
  if (entry.startsWith('.')) return undefined;
  try {
    const name = decodeURIComponent(entry);
    return encodeURIComponent(name) === entry ? name : undefined;
  } catch {
    return undefined;
  }
}

// The workspaces an earlier boot left a folder for: they count as the previous folder, for dir() and for a write that fails. Synchronous: the
// server creates the render synchronously, and a launch may ask dir() before the first write
function existingFolders(root: string): Set<string> {
  try {
    return new Set(readdirSync(root).flatMap((entry) => workspaceOf(entry) ?? []));
  } catch {
    return new Set(); // no <home>/plugins yet
  }
}

// Each Hive item's version for `workspace` over the shipped copy in `tmp`: a skill's folder whole, an agent's main file under both its names, so
// a version's <name>.md.liquid never sits beside a shipped <name>.md. The original is already there, and a user-created item with no version
// listing the workspace is not delivered
async function overlay(home: string, tmp: string, items: readonly CatalogueItem[], workspace: string): Promise<void> {
  for (const item of items) {
    const version = item.origin === HIVE_ORIGIN ? item.versions.find((v) => v.workspaces.includes(workspace)) : undefined;
    if (version === undefined) continue;
    const files = await versionFiles(home, item, version.name);
    if (item.kind === 'skill') {
      const target = join(tmp, 'skills', item.name);
      await rm(target, GONE);
      if (files.paths.length > 0) await cp(files.dir, target, { recursive: true });
      continue;
    }
    const main = mainFiles('specialist', item.name);
    const agents = join(tmp, 'agents');
    for (const name of main) await rm(join(agents, name), { force: true });
    await mkdir(agents, { recursive: true });
    for (const path of files.paths.filter((p) => main.includes(p))) await cp(join(files.dir, path), join(agents, path));
  }
}

// The item a template belongs to, as the path a failure removes: a skill is its whole folder, anything else its own file
function itemPath(path: string): string {
  const parts = path.split('/');
  return parts[0] === 'skills' && parts.length > 2 ? `skills/${parts[1]}` : path;
}

// A plain .md is not Liquid: only its header loses variables and basedOn, so a body that shows `{{ x }}` is delivered as written
const stripHeader = (parsed: ParsedTemplate): RenderResult =>
  parsed.errors.length > 0 ? { ok: false, errors: parsed.errors } : { ok: true, text: `${deliveredHeader(parsed)}${parsed.body}` };

// Every .liquid file, and every .md whose header has declarations (#338, decision 10: its basedOn must not reach Claude Code), rendered for
// `workspace` under its delivered name; any other .md is copied untouched. Answers the items whose template failed, each error logged once. The
// template module's messages hold no path, and the path logged is relative to the folder
async function renderTemplates(tmp: string, workspace: string, log: Pick<Logger, 'error'>): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const path of (await listFiles(tmp)).filter((p) => p.endsWith(LIQUID_SUFFIX) || p.endsWith(MD_SUFFIX))) {
    const parsed = parseTemplate(await readFile(join(tmp, path), 'utf8'));
    if (!path.endsWith(LIQUID_SUFFIX) && !hasDeclarations(parsed.header)) continue;
    const result = path.endsWith(LIQUID_SUFFIX) ? renderTemplate(parsed, workspace) : stripHeader(parsed);
    if (!result.ok) {
      for (const error of result.errors) log.error(`plugin render ${workspace}: ${path}:${error.line} ${error.message}`);
      failed.add(itemPath(path));
      continue;
    }
    const target = deliveredName(path);
    await rm(join(tmp, target), GONE); // a symlink left there by hand is replaced, never written through
    await writeFile(join(tmp, target), result.text);
    if (target !== path) await rm(join(tmp, path)); // a .md is delivered under its own name: removing the source would remove the delivery
  }
  return failed;
}

// The current folder aside, the new one in, the old one gone. Launches wait on ready(), so none reads in between; a failed second rename puts
// the current folder back
async function swap(dir: string, tmp: string, old: string): Promise<void> {
  await rename(dir, old).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // a first write has no folder to set aside
  });
  try {
    await rename(tmp, dir);
  } catch (err) {
    await rename(old, dir).catch(() => undefined);
    throw err;
  }
  await rm(old, GONE).catch(() => undefined); // the new folder is in: a leftover .old-* goes with the next write
}

// What a write needs besides its config; `present` is the set of workspaces with a folder, shared with dir()
interface Ctx {
  home: string;
  root: string;
  pluginSource: string;
  log: Pick<Logger, 'error'>;
  env: () => NodeJS.ProcessEnv;
  present: Set<string>;
}

// One workspace, built in .tmp-<name> and swapped in. A failing template keeps the previous folder whole; with none, the folder goes without
// that item. Any I/O error removes the temporary folder and logs its class
async function writeOne(ctx: Ctx, items: readonly CatalogueItem[], workspace: string): Promise<void> {
  const { home, root, log, present } = ctx;
  let tmp: string | undefined;
  try {
    const dir = pluginRenderPath(home, workspace);
    const name = encodeURIComponent(workspace);
    tmp = join(root, `${TMP_PREFIX}${name}`);
    const old = join(root, `${OLD_PREFIX}${name}`);
    await Promise.all([rm(tmp, GONE), rm(old, GONE)]); // what a crash left
    await cp(ctx.pluginSource, tmp, { recursive: true });
    await overlay(home, tmp, items, workspace);
    const failed = await renderTemplates(tmp, workspace, log);
    if (failed.size > 0 && present.has(workspace)) {
      await rm(tmp, GONE);
      return;
    }
    for (const path of failed) await rm(join(tmp, path), GONE);
    await swap(dir, tmp, old);
    present.add(workspace);
    await prepareCodexWorkspace(dir, ctx.env());
  } catch (err) {
    if (tmp !== undefined) await rm(tmp, GONE).catch(() => undefined);
    log.error(`plugin render ${workspace}: not written (${errorName(err)})`);
  }
}

// Every folder no workspace of the config owns, an earlier boot's included, with its Codex copy and roles. Dot entries stay: .codex holds the
// kept workspaces' roles, and a .tmp-* or .old-* goes with its own workspace's next write
async function sweep(ctx: Ctx, config: RenderConfig): Promise<void> {
  const kept = new Set(config.comb.workspaces.map((w) => w.name));
  for (const entry of await readdir(ctx.root)) {
    if (entry.startsWith('.')) continue;
    const workspace = workspaceOf(entry);
    if (workspace !== undefined && kept.has(workspace)) continue;
    if (workspace !== undefined) ctx.present.delete(workspace); // before the folder goes: a launch in between must not name it
    const dir = join(ctx.root, entry);
    await removeCodexWorkspace(dir, ctx.env()); // first: once the folder is gone, nothing names its Codex copy
    await rm(dir, GONE);
  }
}

async function writeAll(ctx: Ctx, config: RenderConfig, only?: readonly string[]): Promise<void> {
  await mkdir(ctx.root, { recursive: true, mode: DIR_MODE });
  const items = await readCatalogue({ home: ctx.home, pluginSource: ctx.pluginSource, workspaces: config.comb.workspaces });
  for (const { name } of config.comb.workspaces) if (only === undefined || only.includes(name)) await writeOne(ctx, items, name);
  if (only === undefined) await sweep(ctx, config);
}

/** The workspaces' plugin folders (#316): written on boot, on every Settings save and on every custom store change; read by every agent launch
 * through dir(), once ready() settles. */
export function createPluginRender(deps: PluginRenderDeps): PluginRender {
  const { home, log } = deps;
  const root = join(home, PLUGINS_DIR);
  // env is read per write: a test points CODEX_HOME elsewhere after the server is created
  const ctx: Ctx = { home, root, pluginSource: deps.pluginSource, log, env: () => deps.env ?? process.env, present: existingFolders(root) };
  let chain: Promise<void> = Promise.resolve();
  return {
    // One write at a time, each from its own config: two writes in flight never leave the older render on disk
    write: (config, only) => {
      chain = chain.then(() => writeAll(ctx, config, only)).catch((err: unknown) => log.error(`plugin render: not written (${errorName(err)})`));
      return chain;
    },
    dir: (workspace) => {
      if (!ctx.present.has(workspace)) throw new NoPluginFolderError(workspace);
      return pluginRenderPath(home, workspace);
    },
    ready: () => chain,
  };
}
