// The daemon's language servers (#780) and the checkers' own (#782): one process per (activity folder, server binary), started when a page's
// socket asks for it if the server is installed (or the project has its own copy of a checker), its runtime on PATH and the workspace in its scope; stopped LSP_IDLE_MS after its last client, on remove and with the
// Hive; the JSON server gets SchemaStore's file name → schema associations (#794). The folder is the activity's as activityFolders resolves it: the worktree, else the workspace.
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { liveTarget } from './activity-routes.js';
import { checkerOfServer, checkerOn } from './checkers.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { type ConsoleStore, lspChannel } from './console.js';
import { findCandidate } from './formatter-detect.js';
import type { CatalogLoad, SchemaCatalog } from './json-schemas.js';
import type { Logger } from './log.js';
import { type Arch, inScope, isServerId, type Launch, languagesOfServer, type ServerDef, serverDef } from './languages.js';
import { createLspProcess, type LspPeer, type LspProcess, type ProcessSpec } from './lsp-process.js';
import { fileUri } from './lsp-uri.js';
import { activityFolders } from './server-files.js';
import { withoutHiveEnv } from './spawn.js';
import { hiveLaunch, hostArch } from './worker-lsp.js';
import { type Config, LSP_CLOSE, LSP_IDLE_MS, type LspHello, type ServerId, type State } from './types.js';

export interface HostSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  // Overloads, not one loose listener type: a ws WebSocket and the tests' fake both satisfy them without `any`
  on(event: 'message', listener: (raw: Buffer, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}
export interface LspHostDeps {
  home: string;
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  live(): { config: Config; state: State } | undefined;
  idleMs?: number;
  arch?: Arch;
  env?: NodeJS.ProcessEnv; // the daemon's; the workspace's goes on top
  log?: Pick<Logger, 'error'>; // default: stderr
  schemas: SchemaCatalog; // SchemaStore's catalog (#794), one per boot: the JSON server's file name → schema associations
}
export interface LspHost {
  attach(socket: HostSocket, activityId: string, server: string, binary: string): Promise<void>;
  stopServer(id: ServerId): Promise<void>; // its clients close as the server being gone (4404), not as an ordinary stop
  stopAll(): Promise<void>;
}

const OPEN = 1;
type Spec = Omit<ProcessSpec, 'consoleStore' | 'onGone'>;
type Resolved = { key: string; server: ServerId; spec: Spec } | { code: number; reason: string };
const refused = (reason: string): Resolved => ({ code: LSP_CLOSE.refused, reason });

type Editor = Config['editor'];

// Whether a server may run in the workspace (#780, #782): a language's server by its languages' scopes, a checker's by its switch and scope
function isOn(editor: Editor, id: ServerId, workspace: string): boolean {
  const checker = checkerOfServer(id);
  if (checker !== undefined) return checker.languages.some((l) => checkerOn(editor, l, checker.id, workspace));
  return languagesOfServer(id).some((l) => inScope(editor.languages[l]?.server?.workspaces ?? 'all', workspace));
}

// A checker's extra args (#782): one process serves all its languages in a folder, so the first of them that sets some gives them
function extraArgs(editor: Editor, id: ServerId): string[] {
  const checker = checkerOfServer(id);
  if (checker === undefined) return [];
  return checker.languages.map((l) => editor.languages[l]?.checkers?.[checker.id]?.args).find((args) => args !== undefined && args.length > 0) ?? [];
}

// eslint's server asks its settings and validates nothing without them (#782): validate on, run on type, the root as the working directory
const eslintSettings = (root: string): Record<string, unknown> => ({
  validate: 'on', run: 'onType', workingDirectory: { directory: root }, workspaceFolder: { uri: fileUri(root), name: basename(root) },
  nodePath: null, options: {}, rulesCustomizations: [], quiet: false, onIgnoredFiles: 'off', format: false, experimental: {},
  problems: { shortenToSingleLine: false }, codeActionOnSave: { enable: false, mode: 'all' },
  codeAction: { disableRuleComment: { enable: true, location: 'separateLine', commentStyle: 'line' }, showDocumentation: { enable: false } },
});

const JSON_BINARY = 'vscode-json-language-server';

// The JSON server knows a file name's schema only from its client (#794); without the catalog it still checks syntax, and the run says why
const jsonSchemas = (loaded: CatalogLoad): Pick<ProcessSpec, 'afterInitialized' | 'notice'> => ('failure' in loaded
  ? { notice: `JSON schemas unavailable: ${loaded.failure}` }
  : { afterInitialized: [{ method: 'json/schemaAssociations', params: loaded.associations }] });

// What runs (#780, #782): a checker's own copy in the project wins; else the Hive's install, or a system server's tool on PATH, its runtime
// found (hiveLaunch, shared with the workers' plugins, #803)
async function launchOf(deps: LspHostDeps, server: ServerDef, binary: string, root: string, env: NodeJS.ProcessEnv): Promise<Launch | { code: number; reason: string }> {
  const checker = checkerOfServer(server.id);
  const own = checker?.launchesProject ? await findCandidate(checker.project, root, '') : undefined;
  if (own !== undefined) return { command: own, args: [...server.args] };
  const launch = await hiveLaunch(deps.home, server, binary, env.PATH ?? '', deps.arch ?? hostArch());
  return 'reason' in launch ? { code: LSP_CLOSE.absent, reason: launch.reason } : launch;
}

// The process a socket asks for, or why not: the checks the spec lists, in order
async function resolve(deps: LspHostDeps, activityId: string, id: string, binary: string, isRunning: (key: string) => boolean): Promise<Resolved> {
  const live = deps.live();
  if (live === undefined) return refused('the Hive is not configured');
  if (!isServerId(id)) return refused(`${id} is not a language server`);
  const server = serverDef(id);
  if (!server.binaries.includes(binary)) return refused(`${id} has no binary ${binary}`);
  const target = liveTarget(live.state, activityId);
  if ('status' in target) return refused(target.message);
  const folders = activityFolders(live.config, target);
  if ('status' in folders) return refused(folders.message);
  const workspace = target.task ? taskWorkspace(live.config, target.task) : workspaceByName(live.config, target.activity.workspace);
  if (workspace === undefined) return refused('no workspace');
  if (!isOn(live.config.editor, id, workspace.name)) return { code: LSP_CLOSE.outOfScope, reason: `${id} is off in ${workspace.name}` };
  const env = { ...withoutHiveEnv(deps.env ?? process.env), ...workspace.env };
  const root = await realpath(folders.worktree ?? folders.workspace); // a server reports real paths: the page's URIs must match them
  const launch = await launchOf(deps, server, binary, root, env);
  if ('code' in launch) return launch;
  const extra = extraArgs(live.config.editor, id);
  const args = [...launch.args, ...extra];
  const shown = [binary, ...launch.args.filter((arg) => !arg.startsWith('/'))].join(' '); // the user's extra args may hold a token: never in a console header
  const label = target.task ? `#${target.task.item.id}` : workspace.name;
  const settings = id === 'eslint' ? { configuration: eslintSettings(root) } : {};
  const key = [root, binary, ...extra].join('\0'); // new args, a new process
  // Only a start waits for the catalog (bounded by its timeout): a running server already has what it got
  const schemas = binary === JSON_BINARY && !isRunning(key) ? jsonSchemas(await deps.schemas.load()) : {};
  return { key, server: id, spec: { command: launch.command, args, cwd: root, env, root, shown, channel: lspChannel(workspace.name, id), label, ...settings, ...schemas } };
}

/** The daemon's language servers (#780). */
export function createLspHost(deps: LspHostDeps): LspHost {
  const entries = new Map<string, { proc: LspProcess; server: ServerId }>();
  const idles = new Map<string, NodeJS.Timeout>();
  const forget = (key: string): void => { entries.delete(key); clearTimeout(idles.get(key)); idles.delete(key); };
  const stopKey = async (key: string, closing?: { code: number; reason: string }): Promise<void> => { const entry = entries.get(key); forget(key); await entry?.proc.stop(closing); };
  const start = (key: string, server: ServerId, spec: Spec): LspProcess => {
    const proc = createLspProcess({ ...spec, consoleStore: deps.consoleStore, onGone: () => { if (entries.get(key)?.proc === proc) forget(key); } });
    entries.set(key, { proc, server });
    return proc;
  };
  const connect = (socket: HostSocket, key: string, proc: LspProcess, root: string): void => {
    clearTimeout(idles.get(key));
    idles.delete(key);
    const peer: LspPeer = { send: (message) => socket.send(JSON.stringify(message)), close: (code, reason) => socket.close(code, reason) };
    proc.join(peer);
    socket.send(JSON.stringify({ root, log: proc.log } satisfies LspHello));
    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      try { proc.fromPeer(peer, JSON.parse(raw.toString())); } catch { return; } // a frame that is not JSON is dropped, the socket kept
    });
    socket.on('close', () => {
      if (proc.leave(peer) === 0 && entries.get(key)?.proc === proc) idles.set(key, setTimeout(() => void stopKey(key), deps.idleMs ?? LSP_IDLE_MS));
    });
    socket.on('error', () => undefined); // ws closes the socket itself; an 'error' without a listener would throw in the daemon
  };
  return {
    async attach(socket, activityId, server, binary) {
      // resolve touches the disk (realpath, installed.json, PATH): a throw there must close this socket, never reject into the daemon
      const resolved = await resolve(deps, activityId, server, binary, (key) => entries.has(key)).catch((err: unknown): Resolved => {
        (deps.log ?? console).error(`language server ${server} could not start: ${err instanceof Error ? err.message : String(err)}`);
        return refused(`${server} could not start`);
      });
      if (socket.readyState !== OPEN) return; // the page left while the checks ran
      if ('code' in resolved) return socket.close(resolved.code, resolved.reason);
      const proc = entries.get(resolved.key)?.proc ?? start(resolved.key, resolved.server, resolved.spec);
      connect(socket, resolved.key, proc, resolved.spec.root);
    },
    stopServer: async (id) => { await Promise.all([...entries].filter(([, e]) => e.server === id).map(([key]) => stopKey(key, { code: LSP_CLOSE.absent, reason: 'removed' }))); },
    stopAll: async () => { await Promise.all([...entries.keys()].map((key) => stopKey(key))); },
  };
}
