// The language servers for the workers (#803): the servers the Hive installs for the editor pane (#780), handed to every claude run through a
// plugin per workspace, <home>/lsp/<workspace>/, whose .lsp.json Claude Code's own LSP tool reads at launch. Each worker starts its own
// processes; nothing is shared with the LSP host.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { activityOfWorker, taskOfWorker } from './activities.js';
import { taskWorkspace } from './config.js';
import { editorDir, readInstalled } from './editor-install.js';
import { findOnPath } from './formatter-detect.js';
import { type Arch, inScope, LANGUAGES, type Launch, lspLanguageId, runtimeTools, type ServerDef, serverDef, serverFor } from './languages.js';
import type { Logger } from './log.js';
import type { Config, EditorInstallEvent, State, Worker, Workspace } from './types.js';

/** This Mac's arch as the installs name it (#780). */
export const hostArch = (): Arch => (process.arch === 'arm64' ? 'arm64' : 'x64');

/** How the Hive's own install of `server` launches `binary` (#780, #803), shared by the LSP host and the workers' plugins: an installed server's
 * record and folder, or a system server's tool; every runtime tool must be on `path`. Otherwise the reason, which the host's close carries:
 * `not installed` or `requires <tool>`. */
export async function hiveLaunch(home: string, server: ServerDef, binary: string, path: string, arch: Arch): Promise<Launch | { reason: string }> {
  const target = { kind: 'server', id: server.id } as const;
  const installed = server.install === 'system' ? undefined : await readInstalled(home, target);
  if (server.install !== 'system' && installed === undefined) return { reason: 'not installed' };
  for (const tool of runtimeTools(server)) if ((await findOnPath(tool, path)) === undefined) return { reason: `requires ${tool}` };
  return server.launch({ dir: editorDir(home, target), arch, version: installed?.version ?? '' }, binary);
}

/** One server of a workspace's .lsp.json (#803), in Claude Code's plugin LSP format. */
export interface LspEntry { command: string; args: string[]; extensionToLanguage: Record<string, string> }
/** A workspace's .lsp.json (#803): one entry per server binary, named after it. */
export type LspFile = Record<string, LspEntry>;

// Each catalog language's own server. The checkers' servers (#782) are no language's: Claude Code takes the first server that claims an
// extension, so a checker on .ts would shadow the language's server or be shadowed by it
const LANGUAGE_SERVERS = [...new Set(LANGUAGES.flatMap((l) => (l.server === undefined ? [] : [l.server])))];

// .lsp.json refuses a bare command with spaces: a runtime tool (node, a system server's own) becomes the absolute path PATH gives it, which is
// also the runtime the editor's host runs
async function absolute(launch: Launch, path: string): Promise<Launch | undefined> {
  if (isAbsolute(launch.command)) return launch;
  const found = await findOnPath(launch.command, path);
  return found !== undefined && isAbsolute(found) ? { ...launch, command: found } : undefined;
}

/** Every language server binary a worker on `path` could launch (#803), keyed `<server>/<binary>`, its command absolute. */
export async function workerLaunches(home: string, path: string, arch: Arch): Promise<ReadonlyMap<string, Launch>> {
  const binaries = LANGUAGE_SERVERS.flatMap((id) => serverDef(id).binaries.map((binary) => ({ server: serverDef(id), binary })));
  const found = await Promise.all(binaries.map(async ({ server, binary }) => {
    const launch = await hiveLaunch(home, server, binary, path, arch);
    return [`${server.id}/${binary}`, 'reason' in launch ? undefined : await absolute(launch, path)] as const;
  }));
  return new Map(found.flatMap(([key, launch]) => (launch === undefined ? [] : [[key, launch] as const])));
}

/** A workspace's .lsp.json (#803), pure. For each catalog language whose server's scope covers `workspace` and whose binary is in `launches`, its
 * extensions go under that binary's entry, each mapped to the languageId the editor sends in didOpen. web splits its extensions over its three
 * binaries (serverFor), and clangd's two languages merge into one entry. Undefined when no server is left. */
export function renderWorkerLsp(config: Pick<Config, 'editor'>, workspace: string, launches: ReadonlyMap<string, Launch>): LspFile | undefined {
  const served = LANGUAGES.filter((l) => l.server !== undefined && inScope(config.editor.languages[l.id]?.server?.workspaces ?? 'all', workspace));
  const pairs = served.flatMap((l) => l.extensions.flatMap((ext) => {
    const found = serverFor(l.id, ext);
    const launch = found === undefined ? undefined : launches.get(`${found.server.id}/${found.binary}`);
    return found === undefined || launch === undefined ? [] : [{ binary: found.binary, launch, ext }];
  }));
  if (pairs.length === 0) return undefined;
  // a local accumulator: spreading one in a reduce is quadratic
  const entries = new Map<string, LspEntry>();
  for (const { binary, launch, ext } of pairs) {
    const entry = entries.get(binary) ?? { command: launch.command, args: [...launch.args], extensionToLanguage: {} };
    entry.extensionToLanguage[ext] = lspLanguageId(`x${ext}`);
    entries.set(binary, entry);
  }
  return Object.fromEntries(entries);
}

/** Whether an install event changes what the workers' plugins can launch (#803): a server's settled state, never an installing tick nor a
 * syntax package. */
export const settles = (event: EditorInstallEvent): boolean => event.kind === 'server' && event.state.state !== 'installing';

export const LSP_DIR = 'lsp'; // <home>/lsp/<workspace>: the workers' language-server plugins (#803)
const DIR_MODE = 0o700; // under the home, this user's only
const MANIFEST = { name: 'hive-lsp', description: 'The language servers the Hive installed, for this workspace (#803)', version: '1.0.0' };

/** A workspace's plugin folder (#803), its name encoded as its protocol folder's is. No I/O. Throws for a name that would leave <home>/lsp:
 * the config's name rule already refuses those, but this path is also what a write removes. */
export function workerLspPath(home: string, workspace: string): string {
  const name = encodeURIComponent(workspace);
  if (name === '' || name === '.' || name === '..') throw new Error('workspace name outside the lsp folder');
  return join(home, LSP_DIR, name);
}

export interface WorkerLspDeps {
  home: string;
  log: Pick<Logger, 'error'>;
  env?: NodeJS.ProcessEnv; // the daemon's: its PATH unless a workspace sets its own; a test passes its own
  arch?: Arch;
  launches?: (path: string) => Promise<ReadonlyMap<string, Launch>>; // workerLaunches on the home; a test holds one back
}
export interface WorkerLsp {
  write(config: Pick<Config, 'comb' | 'editor'>): Promise<void>; // every workspace's plugin; queued, never rejects
  dir(workspace: string): string | undefined; // the folder the last write left, for the spawn: no I/O
  servers(workspace: string): string[]; // its .lsp.json's entry names, for run.spawned: no I/O
}

// temp + rename, as the protocol files are: a run starting mid-write reads the old file or the new one, never half
async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

// The class only: an fs error's message holds the home's path
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** The workers' language-server plugins (#803): written on boot, on every Settings save and when a server's install settles; read by every
 * claude launch through dir(). */
export function createWorkerLsp(deps: WorkerLspDeps): WorkerLsp {
  const { home, log } = deps;
  const launchesOn = deps.launches ?? ((path: string) => workerLaunches(home, path, deps.arch ?? hostArch()));
  const written = new Map<string, string[]>(); // workspace -> its entries, as the last good write left them
  let chain: Promise<void> = Promise.resolve();
  // One workspace's servers, on the PATH the LSP host would use for it (#780): its own env's over the daemon's. A failure keeps its previous
  // folder and record
  const writeOne = async (config: Pick<Config, 'editor'>, workspace: Workspace): Promise<void> => {
    try {
      const dir = workerLspPath(home, workspace.name);
      const path = workspace.env.PATH ?? (deps.env ?? process.env).PATH ?? '';
      const file = renderWorkerLsp(config, workspace.name, await launchesOn(path));
      if (file === undefined) {
        written.delete(workspace.name); // before the folder goes: a launch in between must not name a folder that is gone
        await rm(dir, { recursive: true, force: true });
        return;
      }
      await put(join(dir, '.claude-plugin', 'plugin.json'), MANIFEST);
      await put(join(dir, '.lsp.json'), file);
      written.set(workspace.name, Object.keys(file));
    } catch (err) {
      log.error(`worker lsp ${workspace.name}: not written (${errorName(err)})`);
    }
  };
  // A folder no workspace of the config owns goes, an earlier boot's included
  const sweep = async (config: Pick<Config, 'comb'>): Promise<void> => {
    const names = new Set(config.comb.workspaces.map((w) => w.name));
    for (const name of [...written.keys()]) if (!names.has(name)) written.delete(name);
    const kept = new Set([...names].map((name) => encodeURIComponent(name)));
    for (const entry of await readdir(join(home, LSP_DIR))) if (!kept.has(entry)) await rm(join(home, LSP_DIR, entry), { recursive: true, force: true });
  };
  const writeAll = async (config: Pick<Config, 'comb' | 'editor'>): Promise<void> => {
    await mkdir(join(home, LSP_DIR), { recursive: true, mode: DIR_MODE });
    for (const workspace of config.comb.workspaces) await writeOne(config, workspace);
    await sweep(config);
  };
  return {
    // One write at a time, each from its own config: two saves in flight never leave the older plugin on disk
    write: (config) => {
      chain = chain.then(() => writeAll(config)).catch((err: unknown) => log.error(`worker lsp: not written (${errorName(err)})`));
      return chain;
    },
    dir: (workspace) => (written.has(workspace) ? workerLspPath(home, workspace) : undefined),
    servers: (workspace) => written.get(workspace) ?? [],
  };
}

/** run.spawned's lsp_servers (#803): the entries of the plugin the run's workspace had, which is what its launch read. A task's run goes by its
 * task's workspace, a local session by its activity's; [] for none. */
export function runLspServers(lsp: Pick<WorkerLsp, 'servers'>, config: () => Pick<Config, 'comb'> | undefined): (state: State, worker: Worker) => { lsp_servers: string[] } {
  return (state, worker) => {
    const current = config();
    const task = taskOfWorker(state, worker);
    const workspace = task === undefined ? activityOfWorker(state, worker)?.workspace : current === undefined ? undefined : taskWorkspace(current, task)?.name;
    return { lsp_servers: workspace === undefined ? [] : lsp.servers(workspace) };
  };
}
