import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { detectAgents } from './agents.js';
import { createSource, createSources, resolveSources } from './source.js';
import { parseConfig, predatesComb, readConfig, unnamedWorkspacePath, workspaceScope } from './config.js';
import { acquireLock, readDaemonPort, releaseLock, removeDaemonSecret, writeDaemonPort, writeDaemonSecret } from './daemon-files.js';
import { PROMPTS_DIR } from './hooks-settings.js';
import { languageFrom, systemLanguage } from './language.js';
import { createLogger, type Logger } from './log.js';
import { predatesTaskProps } from './task-props.js';
import { accessFor } from './read-model/access.js';
import { openReadModel, READ_MODEL_FILE, type ReadModel, type SyncKind } from './read-model/db.js';
import type { ItemStore } from './read-model/items.js';
import { newSecret } from './secret.js';
import { createServer, type HiveServer, type ServerDeps, type SourceFactory } from './server.js';
import { loadState } from './state-store.js';
import { hydrate } from './hydrate.js';
import { openUsageStore } from './usage-store.js';
import { workspacePathProblem } from './worktree.js';
import { MCP_DEFAULTS, APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, CLOSE_TAB_DEFAULTS, CONSOLE_LINES_DEFAULT, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIDEBARS_PER_VIEW_DEFAULTS, SIGNALS_DEFAULTS, SLEEP_NOTICE_DEFAULTS, VIEWER_DEFAULTS, type Source, type SourceItem, type Config, type Exec, type Language } from './types.js';

const execFileAsync: Exec = promisify(execFile);

export interface BootedHive {
  port: number;
  server: HiveServer;
}

/** What run.ts injects into the server (`onStop` ends the daemon, `spawnPty` is node-pty, #251); `launchPty` and `sourceFactory` only the
 * tests (a fake that opens nothing, a machine that is not this one, a source that needs no gh). */
export interface BootOptions extends Pick<ServerDeps, 'readPlanLimits' | 'launchPty' | 'spawnPty' | 'onStop' | 'agents' | 'sourceFactory'> {
  locale?: string; // Electron's app.getLocale(); absent (run.js) → the Node process locale
}

/** What both modes' createServer get: the options plus this boot's secret (#467). */
type BootDeps = Omit<BootOptions, 'locale'> & Pick<ServerDeps, 'secret' | 'usage'>;

export async function bootHive(home: string, options: BootOptions = {}): Promise<BootedHive> {
  const log = createLogger(home); // before anything else: it creates the home, and a config that fails to parse and setup mode log too
  // One daemon per home (#466), under an OS lock a helper holds for the daemon's lifetime (#479): before the prompts sweep and the bind.
  // run.ts releases it on a clean stop; any exit releases it too
  await acquireLock(home, (status) => log.error(`lock: the hive.lock helper exited (${status}); this home no longer keeps a second daemon out`));
  try {
    // A new secret per boot (#467): the daemon never answers without one, and every older copy stops opening it. On disk only after the
    // bind (listenAndRecord), or a client would send it to the old port hive.port still names, which another account may hold by then
    return await bootLocked(home, options, log, newSecret());
  } catch (err) {
    removeDaemonSecret(home); // before releaseLock: once the lock is free, the next daemon writes its own secret
    releaseLock(home); // a failed boot frees the home for the next start at once (#479)
    throw err;
  }
}

async function bootLocked(home: string, options: BootOptions, log: Logger, secret: string): Promise<BootedHive> {
  const { locale, ...given } = options;
  const language = locale === undefined ? systemLanguage() : languageFrom(locale);
  // Only a launch reads a prompt file ($(cat …) in the worker command) and every spawn rewrites it: a previous run's files are dead
  // weight (#107). Here, not in prepareHome: activate calls that on every settings save, with a spawn possibly in flight.
  await rm(join(home, PROMPTS_DIR), { recursive: true, force: true });
  const raw = await readConfig(home).catch((err: Error) => {
    log.error(`config: ${err.message}`);
    throw err;
  });
  // Process state, read once: which agent CLIs this machine has (#516). Installing one later means restarting the Hive, which the hint says.
  const agents = given.agents ?? (await detectAgents(execFileAsync));
  // #271: one store for both modes, since a setup saved in place runs workers too. It never rejects: one that cannot open keeps nothing and says
  // so in hive.log. ponytail: a config that fails to parse leaves it open until the process exits, which it then does
  const usage = await openUsageStore(home, log);
  const deps: BootDeps = { ...given, agents, secret, usage };
  // #190: the model opens before the boot adapters, so each one stores its items there, a reused one included. #401: setup mode gets it too,
  // since the server wires it once: the first Settings save leaves setup mode in place, and its adapters and the read routes need it
  const readModel = await openModel(home, log);
  try {
    return await bootMode(home, log, language, deps, raw, readModel);
  } catch (err) {
    readModel?.close(); // the boot fails (a config that cannot parse, a failed bind): nothing else would close the handle just opened
    throw err;
  }
}

async function bootMode(home: string, log: Logger, language: Language, deps: BootDeps, raw: unknown, readModel: ReadModel | undefined): Promise<BootedHive> {
  if (raw === undefined) return bootSetupMode(home, log, language, deps, readModel);
  const parsed = parseOrFallback(raw, log);
  if ('fallback' in parsed) return bootSetupMode(home, log, language, deps, readModel, parsed.fallback, parsed.proposed);
  const { config } = parsed;
  log.setLevel(config.logLevel);
  // #282: a boot adapter's write answer names its issue row's repository to the open views, through the server once it exists
  const relay: { notify: ItemStore['notify'] } = { notify: () => undefined };
  const items = readModel && bootItemStore(readModel, config, log, (repository, kinds) => relay.notify(repository, kinds));
  // A test injects a source that needs no gh (#740); the daemon builds the real adapters
  const build: SourceFactory = deps.sourceFactory ?? ((spec, store) => createSource(spec, { log, ...(store === undefined ? {} : { items: store }) }));
  const sources = createSources(config, (spec) => build(spec, items));
  let resolved: Map<string, Source>;
  try {
    // #291: a source the network kept out is no broken config: hive mode with it unresolved, the tasks from the read model, a later poll resolves it
    resolved = await resolveSources(sources, { deferOffline: true, log });
  } catch (err) {
    // A saved config whose source is gone (a GitHub Project deleted, access revoked) must not kill the app: reopen the settings form with the reason, which names the source (#180).
    const error = (err as Error).message;
    log.error(`source: ${error}`);
    return bootSetupMode(home, log, language, deps, readModel, { config, error });
  }
  return bootHiveMode(home, log, language, deps, config, resolved, readModel, relay);
}

// The daemon's read model (#180): opened by bootLocked before the boot adapters (#190), under the hive.lock bootHive already holds, in either
// mode (#401); the server closes it. openReadModel imports node:sqlite itself, so its warning stays in the process that opens it. A file
// it cannot open is no reason to stop the Hive: logged, and no read sync runs.
async function openModel(home: string, log: Logger): Promise<ReadModel | undefined> {
  try {
    const { db, resync } = await openReadModel(join(home, READ_MODEL_FILE));
    if (resync) log.info('read model: the file could not be read and was rebuilt empty; a full sync follows');
    return db;
  } catch (err) {
    log.error(`read model: not opened, so nothing syncs: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// The boot adapters' store (#190): rows under the login auth.github reads with, as the server's own store has them. A Settings save that
// changes auth builds new adapters through the server's factory. notify: the server's readModel event, relayed (#282)
// ponytail: one accessFor per poll (a gh config get in cli mode), as the repository reads already pay; cache it if the poll log shows it
function bootItemStore(db: ReadModel, config: Config, log: Logger, notify: ItemStore['notify']): ItemStore {
  return { db, source: async () => (await accessFor(config.auth?.github ?? 'cli', { exec: execFileAsync, log }))?.source, notify };
}

// #191: what every source's read model holds, read with no network call before the first rule runs, so the lean tasks state.json loaded
// get their source fields back. A source whose read fails is logged and skipped: its tasks stay lean until its first poll
async function storedItems(sources: ReadonlyMap<string, Source>, log: Logger): Promise<SourceItem[]> {
  const read = await Promise.all([...sources].map(async ([name, source]): Promise<SourceItem[]> => {
    try {
      return (await source.stored?.()) ?? [];
    } catch (err) {
      log.error(`source ${name}: the read model's listing was not read at boot: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }));
  return read.flat();
}

async function bootHiveMode(
  home: string, log: Logger, language: Language, deps: BootDeps, config: Config, sources: Map<string, Source>, readModel: ReadModel | undefined, relay: { notify: ItemStore['notify'] },
): Promise<BootedHive> {
  const names = config.comb.workspaces.map((p) => p.name).join(',');
  log.info(`boot home=${home} workspaces=${names} mode=hive`);
  // state.json carries a copy of the budget; the config file is the source, so a hand edit wins on boot. #191: its lean tasks get their
  // source fields back from the read model before createServer, so no rule runs on a task without them when the model has them
  const loaded = await loadState(home, workspaceScope(config));
  const saved = { ...loaded, tasks: hydrate(loaded.tasks, await storedItems(sources, log)), budget: config.budget, usageRules: config.usageRules, stages: config.comb.stages, transitions: config.comb.transitions, signals: config.signals };
  // listen() builds the runtime on the bound port, hooks.json and the workspaces' git excludes included (#466)
  const server = createServer({ home, runtime: { config, sources }, state: saved, log, systemLanguage: language, ...deps, ...(readModel === undefined ? {} : { readModel }) });
  relay.notify = (repository: string, kinds: SyncKind[]): void => server.notifyReadModel(repository, kinds);
  const port = await listenAndRecord(server, home, deps.secret);
  await server.boot(saved); // strays and the boot reducer: the same order as the first POST /settings
  await server.poll();
  await server.refreshPlanLimits(); // hive mode skips configure(): the same order, source first, then the account
  console.log(`Agent Hive em http://127.0.0.1:${port} (home: ${home}, workspaces: ${names.split(',').join(', ')}, pid ${process.pid})`);
  return { port, server };
}

// The last port first, so the window and the viewer's cookie keep their origin (the view state no longer depends on it, #484); then
// hive.port names the one bound, for every client and the next boot (#466). Written after the bind: a client never reads a port nothing
// listens on yet. hive.secret after it (#467): a client that reads the new secret reads the port that holds it; one that reads the new
// port with the old secret only fails that request.
async function listenAndRecord(server: HiveServer, home: string, secret: string): Promise<number> {
  const port = await server.listen(readDaemonPort(home));
  writeDaemonPort(home, port);
  writeDaemonSecret(home, secret);
  return port;
}

// A file from before the Comb, or with a source setting from before #293, must not kill the app: the settings form opens empty with the reason
// (no proposal, #132). One from before #198 lacks only the viewer settings: the form opens prefilled with the rest. Any other parse failure is fatal.
function parseOrFallback(raw: unknown, log: Logger): { config: Config } | { fallback: NonNullable<ServerDeps['setupFallback']>; proposed?: string } {
  try {
    return { config: parseConfig(raw) };
  } catch (err) {
    const error = (err as Error).message;
    log.error(`config: ${error}`);
    const prefill = prefillWithoutSettings(raw);
    if (prefill) return { fallback: { config: prefill, error } };
    const proposed = unnamedWorkspacePath(raw); // workspaces saved before they had names (#179): the form reopens with that folder
    if (!predatesComb(raw) && !predatesTaskProps(raw) && proposed === undefined) throw err;
    return { fallback: { error }, ...(proposed === undefined ? {} : { proposed }) };
  }
}

// The file as the form would save it once the settings from #513, #236, #258, #233, #268, #296, #300, #348, #376, #404, #353, #449, #496, #614, #573, #805, #821, #727 and #199 are filled in: only the form
// sees it; nothing is written until a save. A key that is there but wrong still fails here, and so does any other problem.
function prefillWithoutSettings(raw: unknown): Config | undefined {
  try {
    return parseConfig({ ...VIEWER_DEFAULTS, ...CLOSE_TAB_DEFAULTS, ...SLEEP_NOTICE_DEFAULTS, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, theme: 'system', terminalFont: '', trustedDomains: [], consoleLines: CONSOLE_LINES_DEFAULT, shortcuts: {}, sidebarsPerView: SIDEBARS_PER_VIEW_DEFAULTS, signals: SIGNALS_DEFAULTS, mcp: MCP_DEFAULTS, ...(withCommands(raw) as Record<string, unknown>) });
  } catch {
    return undefined;
  }
}

// A file from before #348, or a Comb from before #511 with no command at all (the migration fills comb.commands from workspace commands): a
// workspace without env gets an empty one and the Comb no command, as a setting from before its key gets its default. A key that is there,
// even a wrong one, wins the spread, so the parse still fails on it.
function withCommands(raw: unknown): unknown {
  const comb = typeof raw === 'object' && raw !== null ? (raw as { comb?: unknown }).comb : undefined;
  const workspaces = typeof comb === 'object' && comb !== null ? (comb as { workspaces?: unknown }).workspaces : undefined;
  if (!Array.isArray(workspaces)) return raw;
  const filled = workspaces.map((p: unknown) => (typeof p === 'object' && p !== null ? { env: {}, fork: null, ...p } : p)); // #854: a file from before fork, undecided
  return { ...(raw as object), comb: { commands: [], ...(comb as object), workspaces: filled } };
}

// No hive.config.json (or one whose source cannot be read): serve only the settings form; POST /settings finishes the boot in place.
async function bootSetupMode(
  home: string, log: Logger, language: Language, deps: BootDeps, readModel: ReadModel | undefined,
  setupFallback?: ServerDeps['setupFallback'], proposed?: string,
): Promise<BootedHive> {
  log.info(`boot home=${home} mode=setup reason=${setupFallback?.error ?? 'no hive.config.json'}`);
  // Nothing saved to prefill the form from (an empty home, a file from before the Comb): the folder `hive` ran in, when it is a repo's top
  // level. A viewer launched from the Dock has cwd `/`, so it proposes nothing (#202).
  const cwd = process.cwd();
  const proposedWorkspace = proposed ?? (setupFallback?.config === undefined && (await workspacePathProblem(cwd)) === undefined ? cwd : undefined);
  // The read loop idles until the save sets a config: a round with no repositories reads no login and sends no request
  const server = createServer({ home, setupFallback, proposedWorkspace, log, systemLanguage: language, ...deps, ...(readModel === undefined ? {} : { readModel }) });
  const bound = await listenAndRecord(server, home, deps.secret);
  console.log(`Agent Hive em modo setup em http://127.0.0.1:${bound} (home: ${home}, pid ${process.pid}, ${setupFallback?.error ?? 'sem hive.config.json'})`);
  return { port: bound, server };
}
