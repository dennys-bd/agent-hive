import { execFile } from 'node:child_process';
import { access, rename, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createSource, createSources, resolveSources } from './source.js';
import { awaitDeviceLogin, requestDeviceCode, type DeviceCode, type GithubLoginDeps } from './sources/github-auth.js';
import { cliGql, cliGqlJson, type Exec as GhExec, ghExec, githubLoginName, gqlFor } from './sources/github-gql.js';
import { listFilterOptions, listProjects } from './sources/github.js';
import { branchFor, sessionsOf, taskId, taskLabel, itemSource } from './tasks.js';
import { activityOfWorker, taskOfActivity, taskOfWorker } from './activities.js';
import { CONFIG_FILE, taskWorkspace, parseSource, workspaceByName, workspaceScope, requireWorkspace } from './config.js';
import { createConsoleStore } from './console.js';
import { createInstaller } from './editor-install.js';
import { createSchemaCatalog } from './json-schemas.js';
import { createLspHost } from './lsp-host.js';
import { createWorkerLsp, runLspServers, settles } from './worker-lsp.js';
import { createHeldStops } from './held-stops.js';
import { createMemoryStore } from './memory.js';
import { registerMemoryRoutes, runMemory, writeMemoryProtocols } from './server-memory.js';
import { excludeFromGit, prepareHome, type ProtocolPaths } from './hooks-settings.js';
import { AGENTS, ALL_AGENTS, knownAgent, planLimitAgents, ranAgent } from './agents.js';
import { runners } from './agents/registry.js';
import { createLogger, describeChanges, describeStages, describeEffect, describeEvent, type Logger } from './log.js';
import { createEventLog, type EventLog } from './events.js';
import { createServerEvents, HOOKS_PREFIX, UI_HEADER, WRITE_METHODS } from './server-events.js';
import { canCloseTask, mountMcp } from './mcp.js';
import { createDeliver, type Deliver } from './review-deliver.js';
import { createReviewStore, droppedReviews } from './review-store.js';
import { createPrReviewStore, droppedPrReviews } from './pr-review-store.js';
import { createPtyHost, NO_PTY, type SpawnPty } from './pty-host.js';
import { bracketedPaste } from './pty-paste.js';
import { createBackoffTimers } from './backoff-timers.js';
import { createKeepAwake, type KeepAwakeSpawn, spawnKeepAwake } from './keep-awake.js';
import { syncsFor, effectiveLimits, isChildSession, reduce, SIGNALS } from './orchestrator.js';
import { shutdownCommand } from './platform-commands.js';
import { POLL_INTERVAL_MS, shouldPoll } from './polling.js';
import { openPrUrls, parsePrStates, prNumber, prStatesQuery } from './pull-requests.js';
import { formatRateLimits, PLAN_LIMITS_INTERVAL_MS } from './rate-limits.js';
import { deleteActivityOnDisk, registerTaskRoutes } from './server-tasks.js';
import { createRunSpawner, stagePrompt } from './server-spawn.js';
import { createCiReader } from './server-ci.js';
import { createStageCommandRunner } from './server-stage-commands.js';
import { registerApprovalRoutes } from './server-approval.js';
import { registerDecompositionRoutes } from './server-decomposition.js';
import { registerReviewThreadRoutes } from './server-review-threads.js';
import { registerProjectRoutes } from './server-project.js';
import { canRelateItem, registerBlockerRoutes, relateItem } from './server-blockers.js';
import { registerForkRoutes } from './server-fork.js';
import { registerRepoRoutes } from './server-repos.js';
import { accessFor, type ReadAccess } from './read-model/access.js';
import type { ReadModel, SyncKind } from './read-model/db.js';
import type { ItemStore } from './read-model/items.js';
import { createReadModelLoop, readModelEvent } from './read-model/loop.js';
import { listRepositories } from './repos/repositories.js';
import { registerPrRoutes } from './server-pr.js';
import { registerPrGithubRoutes } from './server-pr-github.js';
import { recordCheckpoint } from './server-checkpoints.js';
import { registerRunRoutes } from './server-runs.js';
import { registerTerminalRoutes } from './server-terminals.js';
import { shellCwd } from './shell-procs.js';
import { removeTerminalFiles, restoreScrollbacks } from './terminal-files.js';
import { allowedHosts, attachPtySocket, type PtySocket } from './server-pty-socket.js';
import { SECRET_FILE } from './daemon-files.js';
import { matchesSecret, pagePolicy, presentedSecret } from './secret.js';
import { registerConsoleRoutes } from './server-console.js';
import { createDesignFrameTokens, registerDesignFrameMint, registerDesignFrameRoute } from './server-design-frame.js';
import { registerEditorInstallRoutes } from './server-editor-install.js';
import { registerLaunchOptionsRoute } from './launch-options.js';
import { registerOpenRoute } from './server-open.js';
import { EDITOR_FILE_ROUTE, editorBodyTooLarge } from './server-editor.js';
import { registerRuleRoutes } from './server-rules.js';
import { registerTrustedDomainRoutes } from './server-trusted-domains.js';
import { registerViewStateRoutes } from './server-view-state.js';
import { registerWorktreeRoutes } from './server-worktrees.js';
import { configFrom, hiveSourceRefusal, movedStages, workspacesRefusal, renamesRefusal, setupRefusal } from './settings-save.js';
import { killStray, writePrompt } from './spawn.js';
import { launchInternalPty } from './spawn-internal.js';
import { createPtyPool } from './ptys.js';
import type { TerminalSize } from './terminal-wire.js';
import { loadState, saveState } from './state-store.js';
import { dropCopiedTranscript } from './transcript.js';
import { trustedCopies } from './copy-sides.js';
import { isTranscriptIn, isTranscriptPath, isWorkerTranscript, type TranscriptTurn } from './usage.js';
import { createViewStore, readViewState } from './view-store.js';
import {
  CONSOLE_LINES_DEFAULT, GITHUB_AUTHS, isLeaving, MAX_CONCURRENT_MAX, NEW_SOURCE_EPICS, SWITCH_AT_DEFAULT,
  type AuthConfig, type Source, type SourceSpec, type Config, type Effect, type EventsPayload, type Exec, type GithubAuth, type Gql,
  type AgentAvailability, type AgentId, type EditorInstallEvent, type GithubAuthStatus, type HiveEvent, type HookPayload, type Language, type PlanLimitsReader, type LivePty, type SettingsBody, type SettingsInfo, type SettingsResult,
  type Signal, type SourceItem, type Worker, type LaunchPty, type State,
} from './types.js';

const execFileAsync: Exec = promisify(execFile);
const SSE_HEARTBEAT_MS = 25_000;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409; // not configured, or the state refuses what was asked
const HTTP_SERVER_ERROR = 500;
const HTTP_NOT_IMPLEMENTED = 501; // POST /stop with no onStop, POST /plan-limits/refresh with no reader
const HTTP_BAD_GATEWAY = 502;
const NO_PLAN_READING = 'the usage endpoint answered no plan window';
const HTTP_NO_CONTENT = 204; // hook routes: an empty body is "no decision" for Claude Code
const NOT_CONFIGURED_MESSAGE = 'Hive não configurado: salve as configurações primeiro';
const FORBIDDEN_HOST_MESSAGE = 'host não permitido';
const FORBIDDEN_ORIGIN_MESSAGE = 'origem não permitida';
const FORBIDDEN_SECRET_MESSAGE = 'segredo inválido';
const SIGNAL_MESSAGE = `signal must be one of: ${SIGNALS.join(', ')}`;
const ARMED_MESSAGE = 'armed must be true or false';
const ON_MESSAGE = 'on must be a boolean';
const TURN_END_EVENTS: readonly string[] = ['Stop', 'StopFailure', 'SessionEnd']; // the only stable points to read a transcript; a failed turn's tokens count too (#805)

export type SourceFactory = (spec: SourceSpec, items?: ItemStore) => Source; // one entry's spec (#180); items: the read model's store, when there is one (#190)

export interface Runtime {
  config: Config;
  sources: Map<string, Source>; // one per comb.sources entry, namespaced (#180)
  hooksPath: string;
  promptsDir: string;
  pluginDir: string;
  protocol: ProtocolPaths; // the protocol files (#167): what a stage run and a free session on a task are told of the Hive's tools
  port: number; // the port listen() bound (#466): hooks.json, the MCP URL, the exit trailer and HIVE_PORT all name it
}

export interface ServerDeps {
  home: string; // the Hive's own directory (#202): hive.config.json, state.json, hive.log, hooks.json, prompts/
  /** This boot's secret (#467): what every request and pty upgrade must carry, and what the workers get in their MCP config (their env gets only the path of hive.secret).
   *  bootHive makes it; tests inject one. */
  secret: string;
  /** Hive mode: the saved config and its resolved sources. listen() builds the Runtime from them on the bound port (#466). */
  runtime?: Pick<Runtime, 'config' | 'sources'>;
  state?: State;
  sourceFactory?: SourceFactory;
  launchPty?: LaunchPty; // tests inject a fake; the default opens a real claude
  spawnPty?: SpawnPty; // node-pty from run.ts (#251); tests a fake. Absent: NO_PTY, and an internal worker fails to start
  log?: Logger; // tests inject a fake; default writes <home>/hive.log
  events?: EventLog; // #742: tests inject a fake; default writes <home>/events.jsonl beside hive.log
  /** The agent CLIs this machine has, detected on boot (#516). Absent (tests) means every agent is available. */
  agents?: AgentAvailability[];
  exec?: Exec; // git for the spawn's worktree, the deleteActivity effect and the task routes, gh for the PR states (#207); tests inject a fake and see the calls
  keepAwakeSpawn?: KeepAwakeSpawn; // #226: the keep-awake child's spawn; tests inject a fake, the default starts caffeinate / systemd-inhibit
  /** The Hive's own reading of the plan limits; absent (every test) means it never reads. main.ts / run.ts inject the real one. */
  readPlanLimits?: PlanLimitsReader;
  /** What POST /stop schedules once its answer is out: run.ts closes the server and exits. Absent (tests, an embedded server) → 501. */
  onStop?: () => void;
  /** Setup mode with a config that failed to boot: prefills the form (when it parsed) and explains why. */
  setupFallback?: { config?: Config; error: string };
  proposedWorkspace?: string; // setup mode with nothing saved: the folder the Hive started in, when it is a repo's top level
  deliverReview?: Deliver; // a review message's delivery (#591); tests inject a fake, the default pastes into the session's pty
  systemLanguage?: Language; // from the locale the boot saw; default en. The config's language wins when set
  /** The GitHub Device Flow's edges (fetch, sleep, the config home); tests inject fakes, the default is the real flow. */
  githubLogin?: GithubLoginDeps;
  /** The settings listings' GraphQL runner for a transport (#245); tests inject a fake, the default is gqlFor with the server's log. */
  settingsGql?: (auth: GithubAuth) => Gql;
  /** #180: hive mode's read model, opened by bootHive; absent (setup mode, a failed open, every server test) no read sync runs. */
  readModel?: ReadModel;
  /** #187: the read sync's login and transports; tests inject a fake, the default is accessFor with auth.github's transport. */
  readAccess?: () => Promise<ReadAccess | undefined>;
}

export interface HiveServer {
  dispatch(event: HiveEvent): Promise<Effect[]>;
  poll(names?: string[], manual?: string[]): Promise<void>; // every named source (all by default), in parallel (#180); manual: items born with auto off (#846)
  boot(saved: State): Promise<void>; // strays killed, then the boot reducer
  refreshPlanLimits(replace?: boolean, agents?: readonly AgentId[]): Promise<string | undefined>; // the failure's reason, undefined when read (or nothing to read); agents: only these (#223)
  listen(port: number | undefined): Promise<number>; // tried first; taken, or undefined, the OS picks one (#466)
  close(reason?: string): Promise<void>; // reason: hive.quit's (#742), `close` by default
  getState(): State | undefined;
}

interface Live {
  runtime: Runtime;
  state: State;
}

// What the reducer resolves workspaces and sources against (#179, #180), what deleting an activity forgets (#236, #573), the shutdown window (#233), the
// approval window (#268), the rate-limit wait (#805) and the default agent (#925), from the config and never from state.json: seeded wherever `live` is created, the way the stages are. A
// source's saved status survives while the source is still configured.
const withWorkspaces = (state: State, config: Config): State =>
  ({ ...state, ...workspaceScope(config), deleteActivity: config.deleteActivity, shutdownIdleMinutes: config.shutdownIdleMinutes, approvalMinutes: config.approvalMinutes, rateLimitWaitMinutes: config.rateLimitWaitMinutes, defaultAgent: config.defaultAgent, syncs: syncsFor(state.syncs, config.comb.sources.map((b) => b.name)) });

/** Boot-only orphan defense: a run of a previous Hive may still hold a worktree. Every run carries its pty id in claude's argv, a
 * free session too through its --mcp-config path (#283): that uuid is the pkill pattern. A terminal needs none: it lived in the old
 * daemon's pty host and died with it (#378). Every occupied worker is given as dead right after. */
export async function killStrays(state: State, exec: Exec = execFileAsync): Promise<void> {
  const patterns = state.workers.flatMap((s) => (s.runId ? [s.runId] : []));
  await Promise.all(patterns.map((pattern) => killStray(pattern, exec)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// What a caller that never checked gets: run.ts headless and every test that does not care about the IDEs.

// Query values are strings: `number` is converted, the rest goes to parseConfig as is so it names the bad field. Listing the Status options
// reads neither the task filter, the task properties nor the epics keys: the source gets the empty filter parseSource requires, a placeholder
// default workspace (#293, #688) and a new source's epics keys (#30).
function sourceFromQuery(query: Request['query']): Record<string, unknown> {
  const { type, owner, number } = query;
  return {
    type, owner, number: typeof number === 'string' && number !== '' ? Number(number) : number, filter: [], taskProps: { defaults: { workspace: 'setup', auto: true }, rules: [] },
    // only lists the project's options and never reaches parseConfig, so a flow without the default stage cannot refuse it
    ...NEW_SOURCE_EPICS, switchAt: SWITCH_AT_DEFAULT,
  };
}

// The settings form works before anything is saved, so the transport rides on the query; absent (or anything unknown) is cli,
// the one that needs no token — an unauthenticated setup can still list a gh-visible GitHub Project.
function authFromQuery(query: Request['query']): AuthConfig {
  const github = query.auth;
  return { github: GITHUB_AUTHS.includes(github as GithubAuth) ? (github as GithubAuth) : 'cli' };
}

export function createServer(deps: ServerDeps): HiveServer {
  const { home } = deps;
  const log = deps.log ?? createLogger(home);
  // A workspace's memory (#797): one file per workspace of the live config; its protocol files follow every change of its rendered text
  const memory = createMemoryStore(home, (name) => live !== undefined && workspaceByName(live.runtime.config, name) !== undefined, log);
  const workerLsp = createWorkerLsp({ home, log }); // #803: one language-server plugin per workspace, for every claude run in it
  // run.spawned's server-side fields (#797, #803): the workspace memory and the language servers its launch read
  const memoryFields = runMemory(memory, () => live?.runtime.config);
  const lspFields = runLspServers(workerLsp, () => live?.runtime.config);
  const wiring = createServerEvents(deps.events ?? createEventLog(home, 'info', { log }), log, Date.now, (state, worker) => ({ ...memoryFields(state, worker), ...lspFields(state, worker) })); // events.jsonl (#742): activate sets its level with the log's
  const createdAt = Date.now(); // hive.booted's start (#742)
  const systemLanguage = deps.systemLanguage ?? 'en';
  const sourceFactory: SourceFactory = deps.sourceFactory ?? ((spec, items) => createSource(spec, { log, ...(items === undefined ? {} : { items }) }));
  // The daemon's ptys (#251) reach every spawn.
  const ptys = createPtyHost(deps.spawnPty ?? NO_PTY, (message) => log.error(message)); // #696: a ring that cannot be written
  const reviews = createReviewStore(home, (itemId) => live?.state.tasks.some((c) => taskId(c) === itemId) === true); // one file per task (#591)
  // One file per PR link (#592), kept for a PR with no task too (#758)
  const prReviews = createPrReviewStore(home);
  // The console's channels (#353), process state like the ptys: a Settings save reaches the next trim, a boot empties them. Before a config
  // nothing runs, so the default only types the read.
  const consoleStore = createConsoleStore(() => live?.runtime.config.consoleLines ?? CONSOLE_LINES_DEFAULT, notifyConsole);
  // The language servers (#780): processes of the Hive, on the console like the runs; the config and state are read per socket
  const lsp = createLspHost({ home, consoleStore, log, schemas: createSchemaCatalog(), live: () => (live ? { config: live.runtime.config, state: live.state } : undefined) });
  const pool = createPtyPool((launch, handlers) => (deps.launchPty ?? launchInternalPty)(launch, handlers, { ptys, secretFile: resolve(home, SECRET_FILE) }));
  const agents = deps.agents ?? ALL_AGENTS;
  const exec = deps.exec ?? execFileAsync;
  const settingsGql = deps.settingsGql ?? ((auth: GithubAuth): Gql => gqlFor(auth, log));
  const spawner = createRunSpawner({ pool, exec, log, dispatch, fail, isLive: (ptyId) => workerOf(ptyId) !== undefined, ptys, consoleStore, agents, secret: deps.secret, home, events: wiring.events, lspDir: workerLsp.dir }); // dispatch and fail are hoisted; workerOf is called later
  // #755: a commands stage's commands, each in a pty of its own; a Stop during index 0's setup is read off the live State once it ends
  const stageCommands = createStageCommandRunner({ exec, pool, ptys, consoleStore, dispatch, prepare: spawner.prepare, current: (activityId) => live?.state.activities.find((a) => a.id === activityId)?.commands });
  // The PR's transport (#207, #592): gh, the login the workers open their PRs with, source or no source. Through an injected exec, so no test runs
  // gh: a write's stdin reaches it as `input`. The real runner is ghExec, which pipes the input itself.
  const gh: GhExec = deps.exec ? async (args, input) => (await exec('gh', args, input === undefined ? undefined : { input })).stdout : ghExec;
  const prGql = cliGql(gh);
  // #834: the CI of every task waiting in a wait-for-CI stage, read on the timer apart from the poll, with the PR poll's transport
  const ci = createCiReader({ gql: prGql, exec, dispatch, log, state: () => live?.state });
  let live: Live | undefined; // hive mode: set by listen() once the port is bound (#466); setup mode: by the first POST /settings
  // One device flow at a time: starting a second aborts the first's poll (its controller) and replaces the worker;
  // the one left behind stops hitting GitHub and can no longer write here even if a token was already in flight.
  let githubFlow: { pending?: DeviceCode; login?: string; error?: string; controller: AbortController } | undefined;
  let boundPort: number | undefined;
  let httpServer: HttpServer | undefined;
  let ptySocket: PtySocket | undefined; // the terminals' WebSocket (#407), on httpServer's upgrades
  let closing = false; // set by close(): a poll still in flight then is stale (isStale) and spawns nothing
  let pollTimer: NodeJS.Timeout | undefined;
  let planLimitsTimer: NodeJS.Timeout | undefined;
  let readModel = deps.readModel; // #180: close() closes it once
  let planLimitsReasons: Partial<Record<AgentId, string>> = {}; // #929: the last failure logged per agent; a repeat is silent, a change and the recovery are one line each
  const clients = new Set<Response>();
  let saveChain: Promise<void> = Promise.resolve();
  let settingsChain: Promise<void> = Promise.resolve();
  // The Stop answers the server owes (#268): the Stop's own continue, and a held Stop that waits for approve, feedback, Parar or its window
  const held = createHeldStops((ptyId) => void dispatch({ type: 'approvalExpired', ptyId }));
  // #805: one timer per run waiting out an API error; its retryDue carries the until it was armed for
  const backoffs = createBackoffTimers((ptyId, until) => void dispatch({ type: 'retryDue', ptyId, until }));

  // #226: the keep-awake process follows State.keepAwake after every reduction. A failure turns the flag off before it is reported: the
  // error's own dispatch would otherwise sync a still-set flag and spawn again (an unsupported platform would loop).
  const keepAwake = createKeepAwake({
    spawn: deps.keepAwakeSpawn ?? spawnKeepAwake,
    pid: process.pid,
    platform: process.platform,
    onFailure: (err) => {
      void dispatch({ type: 'setKeepAwake', on: false })
        .then(() => fail('Keep awake failed', err))
        .catch((e) => log.error(`keep awake: ${errorMessage(e)}`));
    },
  });

  function eventsPayload(): EventsPayload {
    return live ? { ...live.state, effective: effectiveLimits(live.state, Date.now()) } : { configured: false };
  }

  const workerOf = (ptyId: string): Worker | undefined => live?.state.workers.find((s) => s.runId === ptyId);
  // #927: a live run's own runner's pattern; a run already gone has no agent to read, and its bare pty id is in every agent's argv (Claude's
  // <id>.mcp.json path, Codex's x-hive-pty header)
  const strayOf = (ptyId: string): string => {
    const worker = workerOf(ptyId);
    return worker === undefined ? ptyId : runners[ranAgent(worker)].strayPattern(ptyId);
  };

  // What the UI and the status line speak: the saved config's language, else the system's. Setup mode reads the fallback config too.
  const effectiveLanguage = (): Language => (live?.runtime.config ?? deps.setupFallback?.config)?.language ?? systemLanguage;

  function broadcast(): void {
    const data = `data: ${JSON.stringify(eventsPayload())}\n\n`;
    for (const res of clients) res.write(data);
  }

  // A task's review file changed (#591): a named event, so the page's onmessage and the menu bar's frame reader never read it as a State
  function notifyReview(taskId: string): void {
    const data = `event: review\ndata: ${JSON.stringify({ type: 'review', taskId })}\n\n`;
    for (const res of clients) res.write(data);
  }

  // A PR's review file changed, or a write reached GitHub (#592): a named event as review's, so no State reader takes it for one
  function notifyPrReview(url: string): void {
    const data = `event: prReview\ndata: ${JSON.stringify({ type: 'prReview', url })}\n\n`;
    for (const res of clients) res.write(data);
  }

  // #180: a repository's rows changed in the read model; the kinds let a view reload only for its own
  function notifyReadModel(repository: string, kinds: SyncKind[]): void {
    const data = readModelEvent(repository, kinds);
    for (const res of clients) res.write(data);
  }

  // A console channel was added or a run's status changed (#780): the page lists channels by GET /console and learns here, since a format run
  // or a language server is no pty it could watch. A named event as review's; it carries nothing to read.
  function notifyConsole(): void {
    for (const res of clients) res.write('event: console\ndata: {"type":"console"}\n\n');
  }

  // An install's state changed (#780): a named event, as review's, so no State reader takes it for one. A server's settled state changes what
  // the workers' plugins can launch (#803); a progress tick changes nothing. Not awaited: write never rejects, and nothing waits on it
  function notifyEditorInstall(event: EditorInstallEvent): void {
    const data = `event: editorInstall\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
    if (live !== undefined && settles(event)) void workerLsp.write(live.runtime.config);
  }

  // A task the reduction dropped from the State takes its review file with it (#591), whatever route or rule dropped it, a stage change aside
  function dropReviews(prev: State, next: State, event: HiveEvent): void {
    for (const id of droppedReviews(prev, next, event)) void reviews.remove(id).catch((err: Error) => log.error(`review ${id}: ${err.message}`));
    // #592: the tasks' PRs take their review files, unless a task still in the State holds the link; logged by number, never the link
    for (const url of droppedPrReviews(prev, next, event)) void prReviews.remove(url).catch((err: Error) => log.error(`pr review #${prNumber(url)}: ${err.name}`));
  }

  // Serializes writes: dispatch calls can overlap (a hook arriving mid-poll, a worker exit landing
  // inside a kill effect), and two concurrent saveState calls would race on the same state.json.tmp.
  // Chaining onto saveChain queues them, and reading `live` inside the .then ensures a queued save
  // always persists the latest.
  function persist(): Promise<void> {
    saveChain = saveChain
      .then(() => (live ? saveState(home, live.state) : undefined))
      .catch((err: Error) => log.error(`persist failed: ${err.message}`));
    return saveChain;
  }

  // #808: `size` is the grid the page sent with the request behind this event: the spawns this one reduction emits start at it, and no
  // other dispatch (a nested exit, a background one, a later one) carries it
  async function dispatch(event: HiveEvent, size?: TerminalSize): Promise<Effect[]> {
    if (!live) return [];
    log.debug(describeEvent(event));
    const prev = live.state;
    const result = reduce(prev, event);
    // Pinned here, before any await: a background dispatch (dispatchInBackground, #476) can still be running its effect
    // loop below when a later save swaps live.runtime out from under it. Every effect of this one reduction resolves
    // sources against the runtime this event actually reduced against, never whatever live.runtime holds by the time it runs.
    const runtime = live.runtime;
    live = { runtime, state: result.state };
    backoffs.sync(result.state.workers); // #805: a new wait arms its timer, a resumed or gone run's goes
    keepAwake.sync(result.state.keepAwake === true); // #226: every path that sets or clears it; before the effects, so the shutdown's drain releases it first
    dropReviews(prev, result.state, event);
    // Transitions are derived here, not in the reducer: one place covers every rule, current or future, and the reducer stays pure.
    for (const line of describeChanges(prev, result.state)) log.info(line);
    wiring.afterDispatch(prev, result.state, event); // the same transition's structured facts (#742)
    if (result.effects.length > 0) log.debug(`effects: ${result.effects.map(describeEffect).join('; ')}`);
    await persist();
    broadcast();
    // #742: a prompt the Hive is about to type is counted before its UserPromptSubmit can arrive
    for (const effect of result.effects) { wiring.onEffect(effect); await runEffect(effect, runtime, size); }
    return result.effects;
  }

  async function fail(context: string, err: unknown): Promise<void> {
    const message = `${context}: ${errorMessage(err)}`;
    log.error(message);
    await dispatch({ type: 'error', message });
  }

  // Fires an event's effects without making the caller wait on them (#476): dispatch reduces and assigns live.state
  // synchronously before its first await, so the state this event produces is already there once this call returns; only the
  // effects (deleteActivity, sourceAction, spawn) that reduction can emit run in the background. Each effect already reports its own
  // failure through fail(); the catch here is a net for a bug in dispatch itself, never a source or spawn failure.
  function dispatchInBackground(event: HiveEvent): void {
    void dispatch(event).catch((err) => log.error(`background dispatch: ${errorMessage(err)}`));
  }

  // `runtime` is the one dispatch pinned for this batch (#476): every source lookup below resolves against it, never against
  // whatever live.runtime holds by the time this particular effect runs.
  async function runEffect(effect: Effect, runtime: Runtime, size?: TerminalSize): Promise<void> {
    switch (effect.type) {
      case 'setColumn': {
        const source = runtime.sources.get(itemSource(effect.itemId) ?? '');
        if (!source) { // the source was removed in Settings (#180): nothing to write to
          log.info(`${describeEffect(effect)} dropped: no source`);
          return;
        }
        await wiring.sourceAction(live?.state, effect.itemId, 'move', source.setColumn(effect.itemId, effect.column)) // source.action (#742)
          .then(() => log.info(`${describeEffect(effect)} ok`))
          .catch((err) => fail(`source.setColumn(${effect.column})`, err));
        return;
      }
      case 'sourceAction':
        await runSourceAction(runtime, effect);
        return;
      case 'kill':
        log.info(describeEffect(effect));
        spawner.abortSetup(effect.ptyId); // a Stop during the run's worktree setup kills its running step (#351)
        // Awaited: a spawn of the same slug later in this batch only starts once the session is gone (no `duplicate session`).
        // Unknown to the pool (started by a previous Hive): nothing to signal, free the worker ourselves.
        if (!(await pool.kill(effect.ptyId))) await dispatch({ type: 'exit', ptyId: effect.ptyId });
        return;
      case 'spawn':
        // A spawn queued behind a slow effect can reach here after close() began (#476): pool.killAll() already ran, and
        // this child would outlive it. Dropped, not started.
        if (closing) { log.info(`${describeEffect(effect)} dropped: closing`); return; }
        log.info(describeEffect(effect));
        await spawner.spawn(runtime, effect, size).catch((err) => fail(`spawn ${effect.activity.slug ?? ''}`, err));
        return;
      case 'spawnTerminal':
        if (closing) { log.info(`${describeEffect(effect)} dropped: closing`); return; }
        log.info(describeEffect(effect));
        // #696: awaited, so a wake answers its run once the pool holds it; a failure before the pty (its files) sleeps it again, the reason in the bar
        await spawner.spawnTerminal(runtime, effect, size).catch((err: unknown) => dispatch({ type: 'spawnFailed', ptyId: effect.terminal.terminalId, message: errorMessage(err) }));
        return;
      case 'stageCommand': // #755: one command of a commands stage; its pty's end answers stageCommandEnded, so this awaits only its start
        if (closing) { log.info(`${describeEffect(effect)} dropped: closing`); return; }
        log.info(describeEffect(effect));
        await stageCommands.run(runtime, effect).catch((err: unknown) => dispatch({ type: 'stageCommandsRefused', activityId: effect.activity.id, ptyId: effect.ptyId, message: errorMessage(err) }));
        return;
      case 'ciRead': // #834: the wait's first read, at once; the timer reads it after
        if (closing) return;
        log.info(describeEffect(effect));
        await ci.readOne(effect.activityId);
        return;
      case 'ciRerun': // #834: gh calls of up to 60 s each: the batch never waits on them
        log.info(describeEffect(effect));
        void ci.rerun(effect);
        return;
      case 'ciCollect': // #834: always ends in ciFailed
        log.info(describeEffect(effect));
        void ci.collect(effect);
        return;
      case 'spawnSession':
        if (closing) { log.info(`${describeEffect(effect)} dropped: closing`); return; }
        log.info(describeEffect(effect));
        await spawner.spawnSession(runtime, effect, size).catch((err) => fail(`session ${effect.activity.slug ?? effect.activity.workspace}`, err));
        return;
      case 'dropCopiedTranscript': // #587: the new session has its own transcript, or never opened; a failure only leaves a stray file
        log.info(describeEffect(effect));
        await dropCopiedTranscript(effect.dir, effect.sessionId, log).catch((err) => log.error(`transcript copy ${describeEffect(effect)}: ${errorMessage(err)}`));
        return;
      case 'forgetScrollback': // #672: a sleeping run's transcript, once its tab closed, its session continued or it fell out of the last SLEPT_MAX
        log.info(describeEffect(effect));
        ptys.forget(effect.ptyId);
        return;
      case 'readCwd': { // #696: the shell's cwd read before its kill, so the terminal wakes where it was; unreadable keeps the held one
        log.info(describeEffect(effect));
        const cwd = await shellCwd(ptys.pid(effect.terminalId), exec);
        await dispatch({ type: 'sleepTerminal', terminalId: effect.terminalId, ...(cwd === undefined ? {} : { cwd }) });
        return;
      }
      case 'dropTerminalFiles': // #696: a forgotten terminal's ring and history; a failure only leaves a stray file
        log.info(describeEffect(effect));
        ptys.forget(effect.terminalId);
        await removeTerminalFiles(home, effect.terminalId).catch((err) => log.error(`${describeEffect(effect)}: ${errorMessage(err)}`));
        return;
      case 'killCaptured': // #696: the agent the shim started, by its runner's stray pattern (Claude's: its --mcp-config path, <runId>.mcp.json): a
        // session id also matches a `claude --resume <id>`, a tail or a grep elsewhere, and a /clear changes it. The exit frees the worker even when pkill missed
        log.info(describeEffect(effect));
        await killStray(strayOf(effect.ptyId), exec).catch((err) => fail('kill', err));
        await dispatch({ type: 'exit', ptyId: effect.ptyId });
        return;
      case 'captureCheckpoint': { // #619: awaited, so a continue later in this batch answers the Stop only after the capture; a failure is logged
        log.info(describeEffect(effect));
        const workspace = taskWorkspace(runtime.config, effect.task);
        if (workspace) await recordCheckpoint({ exec, log, dispatch, latest: () => live?.state }, { repo: workspace.path, activity: effect.activity, task: effect.task, stage: effect.stage, ended: effect.ended });
        return;
      }
      case 'continue': {
        log.info(describeEffect(effect));
        // a new stage starts here (#283); recordStart keeps a stage's first start (#812), so feedback and a handoff keep theirs (#134)
        await spawner.recordStart(runtime, effect.activity, effect.task, effect.stage.name);
        const reason = effect.prompt ?? stagePrompt(effect.stage, effect.task, effect.result, effect.activity.base);
        // the run's prompt file follows the stage, so the file shows what the worker was last told; the reply is what carries it
        await writePrompt(runtime.promptsDir, effect.activity.slug ?? '', reason).catch((err) => fail(`prompt ${effect.activity.slug ?? ''}`, err));
        held.answer(effect.ptyId, { decision: 'block', reason });
        return;
      }
      case 'hold': held.extend(effect.ptyId, effect.until); return; // the Stop's own handler waits; a later hold (Estender) moves its timer (#268)
      case 'release': held.answer(effect.ptyId); return; // no decision (#268): the window ran out, or the run is being stopped
      case 'input': // typed into a live run's pty: a free session's feedback (#483) or a retry's continue (#805); never dropped while closing: it spawns nothing
        log.info(describeEffect(effect));
        // a pty gone since the reduce (unknown, or its fd already closed: EBADF): the task already left approval and the session's exit is
        // reduced next; the user can send again. Never the text in the line.
        try {
          if (ptys.write(effect.ptyId, bracketedPaste(effect.text))) wiring.typed(effect.ptyId); // #742: only text that reached the pty is the Hive's prompt
          else log.info(`${describeEffect(effect)} dropped: no pty`);
        } catch (err) {
          log.error(`${describeEffect(effect)} failed: ${(err as Error).message}`);
        }
        return;
      case 'deleteActivity': {
        log.info(describeEffect(effect));
        const { activity, task, scope } = effect;
        const activityId = activity.id;
        // In the task's own workspace (#179); none, or one gone, is a failure a manual start retries, like a git refusal. What goes is the scope's (#236).
        const clean = async (): Promise<void> => deleteActivityOnDisk({ workspace: requireWorkspace(runtime.config, task), activity, task, sessions: live ? sessionsOf(live.state, task.item.itemId) : [], branch: branchFor(runtime.config, task.item), scope }, { exec, log, ptys, consoleStore, dispatch, events: wiring.events });
        // Awaited, like kill: the answer is reduced inside this batch, so the next tick sees the task moved or errored, never mid-deletion.
        await clean().then(
          () => dispatch({ type: 'activityDeleted', activityId }),
          (err: unknown) => dispatch({ type: 'deleteActivityFailed', activityId, message: errorMessage(err) }),
        );
        return;
      }
      case 'shutdown': // the reducer already disarmed: a failure is shown, and re-arming retries (#233)
        log.info(describeEffect(effect));
        try { const [file, args] = shutdownCommand(process.platform); await exec(file, [...args]); } // an unsupported platform throws into the bar too (#658)
        catch (err) { await fail('Shutdown failed', err); }
        return;
    }
  }

  // A clean Quit (#696): every live plain terminal reads its cwd and sleeps before the kills, so the next boot wakes it where it was
  async function sleepTerminals(runtime: Runtime): Promise<void> {
    for (const terminal of live?.state.terminals ?? []) {
      if (terminal.command === undefined && terminal.asleep === undefined) await runEffect({ type: 'readCwd', terminalId: terminal.terminalId }, runtime);
    }
  }

  // #286, #515: the source takes an action of a stage's onStart / onFinish. Awaited like the delete activity, so the answer lands inside this batch:
  // a leaving action closes the task once the source confirms (task and session go, the worktree stays), a refusal is logged and handed back
  // as sourceActionFailed with the adapter's words and whether the refused action was the leaving one. No source (removed in Settings, #180): nothing to write, and a leaving task is closed instead of left stuck.
  async function runSourceAction(runtime: Runtime, effect: Extract<Effect, { type: 'sourceAction' }>): Promise<void> {
    const leave = async (): Promise<void> => {
      if (isLeaving(effect.action)) await dispatch({ type: 'closeTask', taskId: effect.taskId });
    };
    const source = runtime.sources.get(itemSource(effect.itemId) ?? '');
    if (!source) {
      log.info(`${describeEffect(effect)} dropped: no source`);
      await leave();
      return;
    }
    try {
      await wiring.sourceAction(live?.state, effect.taskId, effect.action.type, source.apply(effect.itemId, effect.action)); // source.action (#742)
    } catch (err) {
      await fail(`source.apply(${effect.action.type})`, err);
      await dispatch({ type: 'sourceActionFailed', taskId: effect.taskId, message: errorMessage(err), leaving: isLeaving(effect.action) });
      return;
    }
    log.info(`${describeEffect(effect)} ok`);
    await leave();
  }

  // A save can replace the runtime while a poll is in flight (the poll after a save is not awaited, #59): what that
  // poll listed belongs to the old source and is dropped, error included; the new runtime's own poll is already on its way.
  // Same for a poll that outlives close(): its tasks would spawn a worker after killAll(), a child that outlives the Hive.
  const isStale = (runtime: Runtime): boolean => closing || live?.runtime !== runtime;

  // The poll after a save is not awaited: POST /settings already validated and wrote the config, so it answers now and the
  // tasks (and plan limits) reach the dashboard through the SSE stream once this settles (#59). poll() and
  // refreshPlanLimits() answer their own errors; the catch is the net for a bug in either, never a source failure.
  function pollInBackground(andThen?: () => Promise<unknown>): void {
    poll().then(andThen).catch((err) => log.error(`background poll: ${errorMessage(err)}`));
  }

  // Every named source (all by default) in parallel (#180): a slow or failing source never holds the others. With no sources (#132) the
  // source-less poll still runs: it drives the fill and `after`. The worktree and session checks run once, after every source answered.
  async function poll(names?: string[], manual: string[] = []): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    for (const itemId of manual) bornManual.add(itemId);
    try {
      if (runtime.sources.size === 0) await dispatch({ type: 'poll', items: [] });
      const chosen = [...runtime.sources].filter(([name]) => names === undefined || names.includes(name));
      await Promise.allSettled(chosen.map(([name, source]) => pollSource(runtime, name, source)));
      if (isStale(runtime)) return;
      await dropGoneWorktrees();
      await refreshPrStates(); // under the same stale check (#207)
    } finally {
      for (const itemId of manual) bornManual.delete(itemId); // only this poll's reach: an item it did not list enters later with auto on
    }
  }

  // Items a Start dialog created on a source (#846): they enter with auto off, as the hive path creates, so the fill of the poll that brings them
  // in leaves them for their creator. An id goes once its item was listed, and the task keeps its auto from then on (seenAgain never touches it).
  const bornManual = new Set<string>();
  const unattended = (listed: SourceItem): SourceItem => {
    if (!bornManual.delete(listed.item.itemId)) return listed;
    return { ...listed, item: { ...listed.item, autoOnEntry: false } };
  };

  // One source's poll: its tasks, or its failure kept on its own status (the others go on), then its quota, read after every real poll.
  async function pollSource(runtime: Runtime, name: string, source: Source): Promise<void> {
    try {
      const items = await wiring.polled(name, source.listItems()); // source.polled or source.poll_failed (#742)
      if (isStale(runtime)) return;
      log.info(`poll source=${name} items=${items.length}`);
      await dispatch({ type: 'poll', source: name, items: items.map(unattended) });
    } catch (err) {
      if (isStale(runtime)) return;
      const message = errorMessage(err);
      log.error(`source ${name}: ${message}`);
      await dispatch({ type: 'pollFailed', source: name, message });
    }
    if (!isStale(runtime)) await refreshQuota(name, source); // success or failure: the reset time matters most when the limit just hit
  }

  // After every poll: a stopped task whose worktree left the disk behind the Hive's back gets the gone mark (#208), which hides its session
  // button; the path, the branch and the sessions stay. A running one is not checked, its worker is inside. A marked
  // task is not checked again, nor a local task (#444): its folder is the workspace itself. One dispatch per task.
  async function dropGoneWorktrees(): Promise<void> {
    const state = live?.state;
    const stopped = (state?.activities ?? []).flatMap((a) => (a.kind === 'task' && a.worktree !== undefined && !a.local && !a.worktreeGone
      && a.workerId === undefined ? [{ id: a.id, worktree: a.worktree }] : []));
    for (const { id, worktree } of stopped) {
      if (!(await exists(worktree))) await dispatch({ type: 'worktreeGone', activityId: id });
    }
  }

  // Diagnostic only: a failed read is logged and never masks the source error or drops the poll.
  async function refreshQuota(name: string, source: Source): Promise<void> {
    try {
      const quota = await source.quota?.();
      if (quota) await dispatch({ type: 'sourceQuota', source: name, quota });
    } catch (err) {
      log.error(`source ${name} quota: ${errorMessage(err)}`);
    }
  }

  // After every poll (#207): one query for every open PR on every task, one point at most. Diagnostic like refreshQuota: a failure is
  // logged and every PR keeps its last known state; the next poll tries again.
  async function refreshPrStates(): Promise<void> {
    const urls = openPrUrls(live?.state.activityRecords ?? []);
    const query = prStatesQuery(urls);
    if (query === undefined) return;
    try {
      const states = parsePrStates(urls, await prGql(query));
      if (states.length > 0) await dispatch({ type: 'prStates', states });
    } catch (err) {
      log.error(`pr states: ${errorMessage(err)}`);
    }
    await wiring.pollPrActivity(live?.state, urls, prGql); // #742: commits and checks in a query of their own: its failure never costs a merge
  }

  // Info, not error: an API-key user has no OAuth token by design and sees the reason in hive.log once, not every 5 min. The reason never
  // carries the token or a response body
  function notePlanReason(agent: AgentId, reason: string | undefined): void {
    if (planLimitsReasons[agent] === reason) return;
    log.info(`plan limits ${agent}: ${reason ?? 'ok'}`);
    planLimitsReasons = { ...planLimitsReasons, [agent]: reason };
  }

  // Every agent with plan limits (#929), or only `agents` (#223, a chip's ↻): one rateLimits event per reading; a failing agent keeps its
  // last value. `replace`: the usage group's refresh, whose reading is taken whole (see setRateLimits); the timer's is merged. A reason only
  // when no agent gave a reading. Only the agents read note their reason, so one agent's ↻ never clears another's logged failure
  async function refreshPlanLimits(replace = false, agents?: readonly AgentId[]): Promise<string | undefined> {
    const read = deps.readPlanLimits;
    if (!read || !live) return undefined;
    const { readings, failures } = await read(agents);
    for (const agent of planLimitAgents(agents)) notePlanReason(agent, failures.find((f) => f.agent === agent)?.reason);
    for (const { agent, rateLimits } of readings) await dispatch({ type: 'rateLimits', agent, rateLimits, replace });
    if (readings.length > 0) return undefined;
    return failures[0]?.reason ?? (replace ? NO_PLAN_READING : undefined); // the refresh says so; the timer just has nothing to merge
  }

  // Every boot, both paths (bootHive and the first POST /settings): strays of a previous Hive die, then the boot reducer closes every run.
  async function boot(saved: State): Promise<void> {
    await killStrays(saved);
    if (live) live = { ...live, state: trustedCopies(live.state, live.runtime.config) }; // before boot drops the marks' files (#587)
    await dispatch({ type: 'boot' });
    await restoreScrollbacks(home, live?.state.terminals ?? [], ptys.restore); // #696: each sleeping terminal's tab replays its saved ring
    wiring.booted(createdAt);
  }

  // Only the timer asks shouldPoll, per source (#180); /sources/refresh, configure, reconfigure and boot always poll every source: whoever asked
  // wants the answer now. With no sources every tick runs the source-less poll: it costs no network.
  async function tick(): Promise<void> {
    if (!live) return;
    const { state, runtime } = live;
    if (state.shutdown) await dispatch({ type: 'tick' }); // #233: a worker waiting for the user sends no hook, so the clock closes it
    const now = Date.now();
    const due = [...runtime.sources.keys()].filter((name) => shouldPoll(state, name, now));
    if (runtime.sources.size === 0 || due.length > 0) await poll(due);
    await ci.readAll(); // #834: every tick, whatever shouldPoll says: a task holding no worker can delay the poll up to 5 minutes
  }

  async function resolveBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current']);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // Any local process can hit /hooks/event: a transcript path is honoured only when it is the worker's own, so a forged hook cannot turn
  // readTurn into a reader of any `.jsonl` the Hive can open. Dropped, not rejected: the rest of the hook (status, branch) still applies.
  function scopeTranscript(ptyId: string, payload: HookPayload): HookPayload {
    const worker = workerOf(ptyId);
    const task = worker && live ? taskOfWorker(live.state, worker) : undefined;
    const workspace = task !== undefined && live !== undefined ? taskWorkspace(live.runtime.config, task) : undefined;
    // a local session (#587) has no task: it runs in its workspace's checkout
    const activity = worker && live ? activityOfWorker(live.state, worker) : undefined;
    const local = task === undefined && activity?.kind === 'local' && live !== undefined ? workspaceByName(live.runtime.config, activity.workspace) : undefined;
    const agent = ranAgent(worker ?? {}); // #924: its own agent's runner; an unknown pty reads as LEGACY_RUN_AGENT and owns no transcript anyway
    // #929: the runner owns the path. A task worker's is pinned to the hook's own session id: a /clear gives a new one before the worker
    // learns it. A local session's is pinned to the worker's, never the checkout's other transcripts (#590), and to none before it is known
    const own = (task !== undefined && workspace !== undefined && activity !== undefined && isWorkerTranscript(payload.transcript_path, workspace.path, activity, agent, undefined, payload.session_id)) // taskDir's folder (#444)
      || (local !== undefined && worker?.sessionId !== undefined && isTranscriptIn(payload.transcript_path, local.path, agent, undefined, worker.sessionId));
    return payload.transcript_path === undefined || own ? payload : { ...payload, transcript_path: undefined };
  }

  // Reads the transcript only at a turn end, only for a worker this Hive spawned, and only the worker's own `.jsonl` (scopeTranscript): its
  // tokens and its session's /rename title come from the one read (#489).
  async function readTurn(ptyId: string, payload: HookPayload): Promise<TranscriptTurn | undefined> {
    if (!TURN_END_EVENTS.includes(payload.hook_event_name) || !isTranscriptPath(payload.transcript_path)) return undefined;
    const worker = workerOf(ptyId);
    if (!worker || worker.status === 'empty') return undefined;
    return runners[ranAgent(worker)].readTurn(payload.transcript_path, wiring.usageSince(ptyId)).catch(() => undefined); // unreadable: the hook goes through without tokens or a title; usage from the open stage run's start (#742)
  }

  // Builds a Runtime for `config` on the port listen() bound (#466): hooks.json and every worker target the daemon actually listening.
  // `sources` are already resolved by the caller (saveSettings, bootHive): activate never resolves fields itself.
  async function activate(config: Config, sources: Map<string, Source>): Promise<Runtime> {
    if (boundPort === undefined) throw new Error('listen() precisa executar antes de configure()');
    const port = boundPort;
    const { hooksPath, promptsDir, pluginDir, protocol } = await prepareHome(home, port, Object.values(runners)); // #924: every agent's own files, found or not, as hooks.json always was
    await writeMemoryProtocols(memory, config, log); // #797: each workspace's protocol files, its memory under the protocol, before any run reads them
    await workerLsp.write(config); // #803: each workspace's language-server plugin, before any run of the boot or the save loads it; a failure is logged, never the save's
    for (const { path } of config.comb.workspaces) await excludeFromGit(path); // each workspace keeps its worktrees in <path>/.hive/ (#179)
    log.setLevel(config.logLevel); // read from the file on every save: a hand edit switches the level without a restart
    wiring.events.setLevel(config.logLevel); // one switch for both files (#742)
    log.info(`config port=${port} sources=${config.comb.sources.map((b) => `${b.name}:${b.type}`).join(',') || 'none'} logLevel=${config.logLevel} stages=${describeStages(config.comb.stages)}`);
    return { config, sources, hooksPath, promptsDir, pluginDir, protocol, port };
  }

  async function configure(config: Config, sources: Map<string, Source>): Promise<void> {
    if (live) throw new Error('Hive já configurado: use reconfigure()');
    const runtime = await activate(config, sources);
    const saved = await loadState(home, workspaceScope(config));
    // #861: the saved stages first, so a stage a hand edit removed while the Hive was down is a deletion setStages places, never a stranded
    // task; a home with none saved takes the config's. #727: signals on the state before boot, which opens on onOpen
    const flow = saved.stages.length > 0 ? { stages: saved.stages, transitions: saved.transitions } : { stages: config.comb.stages, transitions: config.comb.transitions };
    live = { runtime, state: withWorkspaces({ ...saved, ...flow, signals: config.signals }, config) };
    await boot(saved);
    if (!isDeepStrictEqual(flow.stages, config.comb.stages) || !isDeepStrictEqual(flow.transitions, config.comb.transitions)) {
      await dispatch({ type: 'setStages', stages: config.comb.stages, transitions: config.comb.transitions });
    }
    if (!isDeepStrictEqual(saved.budget, config.budget)) await dispatch({ type: 'setBudget', budget: config.budget });
    if (!isDeepStrictEqual(saved.usageRules, config.usageRules)) await dispatch({ type: 'setUsageRules', usageRules: config.usageRules });
    pollInBackground(refreshPlanLimits);
  }

  async function reconfigure(config: Config, sources: Map<string, Source>, renames: Record<string, string>, stageRenames: Record<string, string>): Promise<void> {
    if (!live) throw new Error('Hive não configurado: use configure()');
    const runtime = await activate(config, sources);
    live = { runtime, state: live.state };
    // First (#278): every fill below, setSources and the poll see the tasks under the names the new runtime has
    if (Object.keys(renames).length > 0) await dispatch({ type: 'renameSources', renames });
    if (Object.keys(stageRenames).length > 0) await dispatch({ type: 'renameStages', renames: stageRenames }); // #861: before setStages, so no renamed stage reads as deleted
    // setBudget, setUsageRules, setStages and setWorkspaces run fill, whose effects (deleteActivity, sourceAction, spawn) can take a
    // while: POST /settings answers once the config is written and reduced, not after those effects settle (#476). renameSources,
    // setDeleteActivity, setShutdownIdle, setApprovalMinutes, setRateLimitWait, setDefaultAgent and setSources emit no effects, so they stay awaited. queueSave only
    // serializes the config write and the reductions themselves, never the effects a reduction fires: those stay pinned to
    // the runtime live held when dispatch reduced them, so a later save's own runtime swap cannot redirect them (#476).
    if (!isDeepStrictEqual(live.state.budget, config.budget)) dispatchInBackground({ type: 'setBudget', budget: config.budget });
    if (!isDeepStrictEqual(live.state.usageRules, config.usageRules)) {
      dispatchInBackground({ type: 'setUsageRules', usageRules: config.usageRules });
    }
    if (!isDeepStrictEqual(live.state.signals, config.signals)) dispatchInBackground({ type: 'setSignals', signals: config.signals }); // #727: it fills, like setUsageRules
    if (!isDeepStrictEqual(live.state.deleteActivity, config.deleteActivity)) await dispatch({ type: 'setDeleteActivity', deleteActivity: config.deleteActivity });
    if (live.state.shutdownIdleMinutes !== config.shutdownIdleMinutes) await dispatch({ type: 'setShutdownIdle', minutes: config.shutdownIdleMinutes });
    if (live.state.approvalMinutes !== config.approvalMinutes) await dispatch({ type: 'setApprovalMinutes', minutes: config.approvalMinutes });
    if (live.state.rateLimitWaitMinutes !== config.rateLimitWaitMinutes) await dispatch({ type: 'setRateLimitWait', minutes: config.rateLimitWaitMinutes }); // #805
    if (live.state.defaultAgent !== config.defaultAgent) await dispatch({ type: 'setDefaultAgent', agent: config.defaultAgent }); // #925
    if (!isDeepStrictEqual(live.state.stages, config.comb.stages) || !isDeepStrictEqual(live.state.transitions, config.comb.transitions)) {
      dispatchInBackground({ type: 'setStages', stages: config.comb.stages, transitions: config.comb.transitions }); // #134: they travel together
    }
    await dispatch({ type: 'setSources', sources: config.comb.sources.map((b) => b.name) }); // every save (#180): a removed source's tasks go missing at the next poll
    dispatchInBackground({ type: 'setWorkspaces', ...workspaceScope(config) }); // every save (#179): a new default or workspace can place a waiting task
    pollInBackground();
  }

  async function writeConfigFile(config: Config): Promise<void> {
    const path = join(home, CONFIG_FILE);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
    await rename(tmp, path);
  }

  function requireLive(res: Response): Live | undefined {
    if (!live) res.status(HTTP_CONFLICT).json({ error: NOT_CONFIGURED_MESSAGE });
    return live;
  }

  const app = express();
  const designFrames = createDesignFrameTokens(); // #108: one store per boot, written by the mint and read by the frame route

  // Rejects DNS-rebinding / cross-origin requests that don't target this exact bound
  // address: hooks and the UI always call http://127.0.0.1:<port> or localhost:<port>.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const port = boundPort;
    if (port === undefined || !allowedHosts(port).includes(req.headers.host ?? '')) { // the same list the pty socket checks (#407)
      res.status(HTTP_FORBIDDEN).json({ error: FORBIDDEN_HOST_MESSAGE });
      return;
    }
    next();
  });
  // #108: between the Host check and the secret. The sandboxed frame presents no credential: its URL's token is the capability, and the
  // route never reads the port's cookie
  registerDesignFrameRoute(app, { tokens: designFrames, log });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const port = boundPort ?? 0; // the Host check above refused every request before listen bound the port
    // The Host check stops a web page, not a process: anything that reaches 127.0.0.1 knows the header names, another account's process
    // included. Only this boot's secret opens the daemon (#467): hive.secret (0600), a worker's env, the viewer's cookie. The log line
    // names the request, never the value presented.
    if (!matchesSecret(deps.secret, presentedSecret(req, port))) {
      log.debug(`refused without the secret: ${req.method} ${req.path}`);
      res.status(HTTP_FORBIDDEN).json({ error: FORBIDDEN_SECRET_MESSAGE });
      return;
    }
    // Neither check stops a page on another port of 127.0.0.1: the browser sends it the viewer's cookie too (same site). Dashboard routes
    // need a header only the UI sends; a form cannot set one, and a cross-origin fetch that does hits a preflight the server never
    // answers. Hook routes are exempt: a worker's curl never sends it.
    if (WRITE_METHODS.includes(req.method) && !req.path.startsWith(HOOKS_PREFIX) && req.header(UI_HEADER) === undefined) {
      res.status(HTTP_FORBIDDEN).json({ error: FORBIDDEN_ORIGIN_MESSAGE });
      return;
    }
    next();
  });
  app.use(wiring.httpRecords(() => live?.state)); // #742: after the gate, so a refusal there stays its debug line, not a flood of http.error
  // After the gate: a request refused above is never parsed (#467)
  app.use(express.json({ limit: '2mb' }));
  app.use(EDITOR_FILE_ROUTE, editorBodyTooLarge); // #717: a save over the parser's limit answers the editor's own 413, not Express's page

  // Answers only after its own dispatch: the worker's hook blocks until curl returns, so a PR seen on PostToolUse is applied before the
  // worker goes on. Empty 204 = no decision; the one exception is a Stop whose dispatch decided to continue in place: 200 with the JSON, or one held for approval (#268).
  app.post('/hooks/event', async (req: Request, res: Response) => {
    const ptyId = req.header('x-hive-pty');
    const body = req.body as HookPayload | undefined;
    // #928: the worker's own agent's runner makes its hook the reducer's before anything reads it; an unknown pty reads as
    // LEGACY_RUN_AGENT (Claude), whose payload goes through unchanged
    const agent = ranAgent((ptyId === undefined ? undefined : workerOf(ptyId)) ?? {});
    // only a string event is a hook: a forged object name would throw in a template literal down the line, so it reads as no event name
    const event = typeof body?.hook_event_name === 'string' && body.hook_event_name !== '' ? body.hook_event_name : undefined;
    const raw = ptyId && event && body ? runners[agent].hookPayload(body) : undefined;
    if (ptyId && event && raw === undefined) { // dropped by the runner: a subagent's hook, Codex's SessionEnd
      log.debug(`hook ignored: ${agent} ${event}`);
      res.status(HTTP_NO_CONTENT).end();
      return;
    }
    const payload = ptyId && raw ? scopeTranscript(ptyId, raw) : undefined;
    // Computed once against the worker as it stands: a subagent/teammate Stop, StopFailure or SessionEnd must not read the transcript, same as the reducer ignores it (#24, #805)
    const isChild = ptyId !== undefined && payload !== undefined && isChildSession(workerOf(ptyId), payload);
    let effects: Effect[] = [];
    if (ptyId && payload) {
      const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
      const turn = isChild ? undefined : await readTurn(ptyId, payload);
      if (!isChild) wiring.beforeHook(live?.state, ptyId, payload, turn?.usage); // #742: the human signals read the worker before this hook moves it
      effects = await dispatch({ type: 'hook', ptyId, payload, branch, tokens: turn?.tokens, title: turn?.title });
    } else {
      log.debug(`hook ignored: ${ptyId ? 'no event name' : 'no pty id'}`);
    }
    // The Stop's answer: a continue of its own dispatch, or an answer the user gave meanwhile, goes out now; a hold waits for the user (#268)
    const hold = effects.find((e): e is Extract<Effect, { type: 'hold' }> => e.type === 'hold' && e.ptyId === ptyId);
    const continues = effects.some((e) => e.type === 'continue' && e.ptyId === ptyId);
    if (ptyId !== undefined && (hold || continues)) held.settle(ptyId, res, hold?.until);
    else res.status(HTTP_NO_CONTENT).end();
  });

  // The worker's command line ends with a curl here. Unknown to the pool (started by a previous Hive): free the worker ourselves.
  app.post('/hooks/exit', async (req: Request, res: Response) => {
    res.sendStatus(200);
    const ptyId = req.header('x-hive-pty');
    if (ptyId && !pool.exit(ptyId)) await dispatch({ type: 'exit', ptyId });
  });

  // The worker's status line posts its whole JSON here; only `rate_limits` is kept, and the reply is the line the worker's tab shows.
  app.post('/hooks/status', async (req: Request, res: Response) => {
    res.type('text/plain');
    const ptyId = req.header('x-hive-pty');
    // #924: the reporting worker's agent reads its own status line; an unknown pty reads as LEGACY_RUN_AGENT, and the reducer ignores its reading
    const agent = ranAgent((ptyId === undefined ? undefined : workerOf(ptyId)) ?? {});
    const rateLimits = runners[agent].statusLimits(req.body, Date.now());
    if (!ptyId || !rateLimits) {
      res.send('');
      return;
    }
    res.send(formatRateLimits(rateLimits, effectiveLanguage())); // from the payload, not the State: an unknown worker gets the line and the reducer ignores it
    await dispatch({ type: 'rateLimits', agent, ptyId, rateLimits }); // #929: the worker's agent's reading
  });
  // The worker's tools (#99): hive_done, hive_pr, hive_ask, hive_create_task, hive_stop (#314) and its block (#294, the blockers route's own write), hive_reply (#591). State and sources are read at call time: a POST /settings may replace them.
  mountMcp(app, { exec, live: () => (live ? { state: live.state, config: live.runtime.config, sources: live.runtime.sources } : undefined), poll, dispatch, canClose: (itemId) => live !== undefined && canCloseTask(live.state, live.runtime.config.comb.sources, itemId),
    relate: (itemId, change) => relateItem({ dispatch, latest: () => live?.state, log }, live, itemId, change), canRelate: (itemId) => live !== undefined && canRelateItem(live, itemId),
    reviews, notifyReview, events: wiring.events, memory });

  app.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(eventsPayload())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  app.get('/settings', (_req: Request, res: Response) => {
    const language = effectiveLanguage();
    const proposal = deps.proposedWorkspace === undefined ? {} : { proposedWorkspace: deps.proposedWorkspace };
    const info: SettingsInfo = live
      ? { configured: true, home, config: live.runtime.config, language, agents }
      : { configured: false, home, ...deps.setupFallback, ...proposal, language, agents };
    res.json(info);
  });

  app.get('/settings/projects', async (req: Request, res: Response) => {
    const owner = req.query.owner;
    if (typeof owner !== 'string' || owner === '') {
      res.status(HTTP_BAD_REQUEST).json({ error: 'owner obrigatório' });
      return;
    }
    try {
      res.json(await listProjects(owner, settingsGql(authFromQuery(req.query).github)));
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });

  app.get('/settings/source-columns', async (req: Request, res: Response) => {
    let spec: SourceSpec;
    try {
      // only the source and the transport matter here; the name cites no source column
      spec = {
        auth: authFromQuery(req.query), source: { ...parseSource(sourceFromQuery(req.query), 'source', ['setup']), name: 'setup', qualifyId: false }, stages: [], transitions: [],
      };
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    try {
      res.json(await sourceFactory(spec).settingsOptions());
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });

  // #245: a github source's filter options, which the form asks together with its columns. The number rides as text and must be one.
  app.get('/settings/filter-options', async (req: Request, res: Response) => {
    const { owner, number } = req.query;
    if (typeof owner !== 'string' || owner === '' || typeof number !== 'string' || !/^\d+$/.test(number)) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'owner e number obrigatórios' });
      return;
    }
    try {
      res.json(await listFilterOptions(owner, Number(number), settingsGql(authFromQuery(req.query).github)));
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });

  // Answers the code immediately; the polling outlives the request, because the browser cannot hold a 15-minute fetch open.
  app.post('/settings/github/login', async (_req: Request, res: Response) => {
    let device: Awaited<ReturnType<typeof requestDeviceCode>>;
    try {
      device = await requestDeviceCode(deps.githubLogin);
    } catch (err) {
      // A failed start must leave whatever flow was already running alone: aborting before this point would let a
      // still-pending flow's own "cancelled" rejection pass the identity guard below and overwrite its pending code.
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
      return;
    }
    const controller = new AbortController();
    const flow: typeof githubFlow = {
      pending: { userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn },
      controller,
    };
    githubFlow?.controller.abort(); // only now, once this flow can actually replace it, does the old one lose its worker
    githubFlow = flow;
    void awaitDeviceLogin(device, { ...deps.githubLogin, signal: controller.signal }).then(
      (login) => { if (githubFlow === flow) githubFlow = { login, controller }; },
      (err: Error) => { if (githubFlow === flow) githubFlow = { error: err.message, controller }; },
    );
    log.info('github login started');
    res.json({ userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn });
  });

  // What the settings screen polls every 2 s while a flow is pending. The token is never part of the answer.
  app.get('/settings/github/auth', async (_req: Request, res: Response) => {
    const login = await githubLoginName(deps.githubLogin?.env);
    const status: GithubAuthStatus = {
      connected: login !== undefined,
      ...(login !== undefined ? { login } : {}),
      ...(githubFlow?.pending ? { pending: { userCode: githubFlow.pending.userCode, verificationUri: githubFlow.pending.verificationUri } } : {}),
      ...(githubFlow?.error ? { error: githubFlow.error } : {}),
    };
    res.json(status);
  });

  // Serializes saves: two concurrent POST /settings would race on hive.config.json.tmp and
  // into configure()/reconfigure(). Chaining queues them in arrival order; each request
  // awaits its own link, and the chain never rejects because saveSettings answers every error.
  // POST /trusted-domains (#404) and PUT /workspaces/:name/memory/cap (#115) queue on the same chain: one writer of the file.
  function queueSave(save: () => Promise<void>): Promise<void> {
    settingsChain = settingsChain.then(save, save);
    return settingsChain;
  }

  app.post('/settings', (req: Request, res: Response) => queueSave(() => saveSettings((req.body ?? {}) as Partial<SettingsBody>, res)));

  async function saveSettings(body: Partial<SettingsBody>, res: Response): Promise<void> {
    let config: Config;
    try {
      config = await configFrom(home, body);
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    const current = live && { config: live.runtime.config, state: live.state };
    const refusal = (await workspacesRefusal(config, current)) ?? setupRefusal(config) ?? renamesRefusal(body.renames, config, current) ?? hiveSourceRefusal(config, current?.state, config.language ?? effectiveLanguage()); // all before any write (#278, #299)
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.message });
      return;
    }
    // An entry whose baked-in parts match the live runtime's keeps its instance, so a write already in flight keeps its chain (#180: per source).
    const sources = createSources(config, (spec) => sourceFactory(spec, itemStore), live && { config: live.runtime.config, sources: live.runtime.sources });
    try {
      await resolveSources(sources); // validates every source against the real one before the config is written; the message names the source
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    try {
      await writeConfigFile(config);
      log.info('settings saved');
      await (live ? reconfigure(config, sources, body.renames ?? {}, movedStages(body.stageRenames)) : configure(config, sources)); // a first setup has no tasks to carry (#278)
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
      return;
    }
    const result: SettingsResult = { ok: true };
    res.json(result);
  }

  app.post('/config', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const max = (req.body as { maxConcurrent?: unknown }).maxConcurrent;
    if (!Number.isInteger(max) || (max as number) < 0 || (max as number) > MAX_CONCURRENT_MAX) {
      res.status(HTTP_BAD_REQUEST).json({ error: `maxConcurrent must be an integer from 0 to ${MAX_CONCURRENT_MAX}` });
      return;
    }
    await dispatch({ type: 'setMax', max: max as number });
    res.json({ ok: true });
  });

  app.post('/signal', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const signal = (req.body as { signal?: unknown }).signal;
    if (!SIGNALS.includes(signal as Signal)) {
      res.status(HTTP_BAD_REQUEST).json({ error: SIGNAL_MESSAGE });
      return;
    }
    await dispatch({ type: 'setSignal', signal: signal as Signal });
    res.json({ ok: true });
  });

  // The main window's power toggle (#233): shut down when done. The reducer caps the signal, closes a worker waiting past the window, and emits
  // the shutdown once no worker is left.
  app.post('/shutdown', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const armed = (req.body as { armed?: unknown }).armed;
    if (typeof armed !== 'boolean') {
      res.status(HTTP_BAD_REQUEST).json({ error: ARMED_MESSAGE });
      return;
    }
    await dispatch({ type: 'setShutdown', armed });
    res.json({ ok: true });
  });

  // The footer's keep awake (#226): one click on or off, no confirm. dispatch syncs the holder from the state.
  app.post('/keep-awake', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const on = (req.body as { on?: unknown }).on;
    if (typeof on !== 'boolean') {
      res.status(HTTP_BAD_REQUEST).json({ error: ON_MESSAGE });
      return;
    }
    await dispatch({ type: 'setKeepAwake', on });
    res.json({ ok: true });
  });

  // POST /rules/disable and /rules/enable (#297): the strip's desligar and religar, behind the same host / origin middleware
  registerRuleRoutes(app, { requireLive, dispatch });

  // POST /trusted-domains (#404): the terminal link dialog's "always trust", saved through the same chain and saveSettings as POST /settings
  registerTrustedDomainRoutes(app, { requireLive, queueSave, saveSettings });

  // GET /view-state and POST /view-state/:key (#484): the dashboard's layout in the home, so a new port keeps it; loaded once, here
  registerViewStateRoutes(app, { store: createViewStore(home, readViewState(home)), log });
  // The memory dialog's routes (#797): GET/POST /workspaces/:name/memory, GET …/stats, PUT/DELETE …/:id, saved at once; PUT …/cap (#115) on
  // the same chain and saveSettings as POST /settings
  registerMemoryRoutes(app, { requireLive, memory, events: wiring.events, log, home, queueSave, saveSettings });

  // create, start, bases, close, keep, session, session exit, delete-activity, move, reset-order, close-missing, auto, worktree, open, move-to, open-ref, files: same host/origin middleware ordering, registered here
  // The page attaches a run POST /open started at once (#249): the answer waits for its pty to exist.
  const taskDeps = { exec, log, requireLive, dispatch, poll, latest: () => live?.state, started: pool.started, language: effectiveLanguage, agents, reviews, notifyReview, ptys, consoleStore, events: wiring.events };
  // GET /worktrees, GET /activities/worktrees and POST /worktrees/:workspace/:slug/remove (#181): the Settings tab's worktrees, behind the same
  // host/origin middleware; before every /activities/:id/* route (#629), so `worktrees` is never read as an activity id
  registerWorktreeRoutes(app, { exec, log, requireLive, ptys, consoleStore, dispatch, events: wiring.events });
  registerTaskRoutes(app, taskDeps);
  registerDesignFrameMint(app, { requireLive, tokens: designFrames }); // GET /activities/:id/design-frame (#108): behind the gate, like the editor's file routes
  // The review's conversations (#591): delivered into a session's pty, or into one openSession starts for them. A pty whose fd closed since
  // throws (EBADF, as the input effect meets it): that delivery failed, the others go on.
  const write = (ptyId: string, data: string): boolean => {
    try { return ptys.write(ptyId, data); } catch { return false; }
  };
  const deliverReview = deps.deliverReview ?? createDeliver({ state: () => live?.state, dispatch, started: pool.started, write });
  registerReviewThreadRoutes(app, { requireLive, reviews, notifyReview, log, deliver: deliverReview });
  registerOpenRoute(app, taskDeps); // POST /tasks/:id/open and /activities/:id/open, whose first worktree setup runs in the console (#351)
  registerLaunchOptionsRoute(app, taskDeps); // GET /launch-options: the new session dialog's lists (#257)
  // POST /ptys/:id/stop and POST /crash/dismiss (#283, #570): behind the same host / origin middleware
  registerRunRoutes(app, taskDeps);
  registerTerminalRoutes(app, { requireLive, live: () => live, running: pool.has, dispatch, started: pool.started, secret: deps.secret, exec, pid: (ptyId) => ptys.pid(ptyId), home, recordStart: spawner.recordStart, lspDir: workerLsp.dir }); // wake, forget (#696); the shim's register under /hooks/
  registerApprovalRoutes(app, taskDeps); // POST /activities/:id/approve, /feedback, /approval/extend (#268)
  registerDecompositionRoutes(app, { requireLive, dispatch, exec, gql: cliGqlJson(gh) }); // GET and POST /activities/:id/decomposition (#865): read the tree, write it with the Hive's own login as #757's writes
  registerConsoleRoutes(app, { requireLive, consoleStore }); // GET /console and /console/:id (#353)
  // Settings › editor's installs and the syntax packages' files (#780); a removed server's processes stop first
  registerEditorInstallRoutes(app, { home, installer: createInstaller({ home, onState: notifyEditorInstall, beforeSwap: (t) => (t.kind === 'server' ? lsp.stopServer(t.id) : Promise.resolve()) }), stopServer: (id) => lsp.stopServer(id) });

  app.post('/sources/refresh', async (_req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await poll();
    res.json({ ok: true });
  });
  registerProjectRoutes(app, { requireLive, dispatch, log }); // GET /sources/:name/project, POST …/project/status and an item's fields (#756, #686): a write dispatches itemRead, no poll
  registerBlockerRoutes(app, { requireLive, dispatch, latest: () => live?.state, log }); // POST /sources/:name/items/:itemId/blockers (#56): a hive task's relation by blockerSet, a source's through its relate, then itemRead
  // #180: the read model's sync over the repositories the Hive lists, as the login auth.github names, read per round so a Settings change
  // takes the next one. No auth (no GitHub source): cli, the transport the repository routes already read with
  const readAccess = deps.readAccess ?? (() => accessFor(live?.runtime.config.auth?.github ?? 'cli', { exec, log }));
  // #190: what a Settings save's GitHub adapters store their items in: the daemon's model, under the login the read sync reads with
  const itemStore: ItemStore | undefined = deps.readModel && { db: deps.readModel, source: async () => (await readAccess())?.source, notify: notifyReadModel };
  const readLoop = deps.readModel && createReadModelLoop({
    db: deps.readModel, log, notify: notifyReadModel, access: readAccess,
    repositories: async () => (live ? listRepositories(live.runtime.config, live.state, exec) : []),
  });
  // #181: the reads answer from the model, as the login the sync reads with (ponytail: one gh config get per read in cli mode); the writes
  // go to GitHub with the Hive's own login (#757), and their answer is upserted and named by the sync's own readModel event (#183)
  const repoModel = deps.readModel === undefined || readLoop === undefined ? {} : {
    readModel: { db: deps.readModel, source: async () => (await readAccess())?.source, refetch: readLoop.refetch, notify: notifyReadModel },
  };
  registerRepoRoutes(app, { requireLive, exec, gql: cliGqlJson(gh), poll, log, ...repoModel });
  // The PR page (#592, #758): its read and review file, then its writes to GitHub; its reads answer from the read model and its writes upsert
  // their answer (#187), so it registers after the read loop
  const prDeps = { requireLive, dispatch, log, exec, prReviews, notifyPrReview, gql: prGql, gqlJson: cliGqlJson(gh), gh, ...repoModel };
  registerPrRoutes(app, prDeps);
  registerPrGithubRoutes(app, prDeps); // comment, review, reply, resolve, merge (#592)
  registerForkRoutes(app, { requireLive, exec }); // POST /workspaces/:name/sync and GET /settings/remotes, a fork workspace's (#854)

  // The usage group's ↻ (#223): `{ agent }` reads that agent only, `{}` every agent with plan limits (↻ todos); either replaces the held
  // reading, e.g. after a plan upgrade lowered the percent. The page only offers ↻ on agents with plan limits: anything else is a 400
  app.post('/plan-limits/refresh', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    if (!deps.readPlanLimits) {
      res.status(HTTP_NOT_IMPLEMENTED).json({ error: 'plan limits not supported' });
      return;
    }
    const asked: unknown = (req.body as { agent?: unknown } | undefined)?.agent;
    const agent = knownAgent(asked);
    if (asked !== undefined && (agent === undefined || !AGENTS[agent].planLimits)) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'agent has no plan limits' });
      return;
    }
    const reason = await refreshPlanLimits(true, agent === undefined ? undefined : [agent]);
    if (reason === undefined) res.json({ ok: true });
    else res.status(HTTP_BAD_GATEWAY).json({ error: reason });
  });

  // `hive stop` (with the UI header, like every dashboard POST). The answer goes out first; close() drops every connection, so
  // the callback runs on the next turn of the loop. close() itself is what the old will-quit ran: every worker killed. close() records the
  // Quit before its kills (#283).
  app.post('/stop', (_req: Request, res: Response) => {
    const onStop = deps.onStop;
    if (!onStop) {
      res.status(HTTP_NOT_IMPLEMENTED).json({ error: 'stop not supported' });
      return;
    }
    log.info('stop requested');
    res.json({ ok: true });
    setImmediate(onStop);
  });

  // The viewer's menu: `active` counts what a stop would kill, sessions and terminals included (#193, #283); `ptys` lists them (#192, #570):
  // every live worker whose task is still there, in worker order, then every terminal, labelled as the footer chips are, then every commands
  // stage's running command (#755). Nothing in setup mode.
  app.get('/ptys', (_req: Request, res: Response) => {
    const state = live?.state;
    const occupied = state?.workers.filter((w) => w.status !== 'empty' && w.runId !== undefined) ?? []; // #727: a commands run's worker has no pty; its command's line below counts it
    const terminals = (state?.terminals ?? []).filter((t) => t.asleep === undefined); // #696: a sleeping terminal has no pty to stop
    const runLines = state === undefined ? [] : occupied.flatMap((worker): LivePty[] => {
      if (!worker.runId) return [];
      const status = worker.status as LivePty['status'];
      const activity = activityOfWorker(state, worker);
      if (activity?.kind === 'local') return [{ id: worker.runId, status, label: activity.workspace }]; // a local session (#587): no task to open
      const task = taskOfWorker(state, worker);
      return task ? [{ id: worker.runId, taskId: taskId(task), status, label: taskLabel(task) }] : [];
    });
    const terminalLines = state === undefined ? [] : terminals.flatMap((terminal): LivePty[] => {
      const activity = state.activities.find((a) => a.id === terminal.activityId);
      if (activity?.kind === 'local') return [{ id: terminal.terminalId, status: 'terminal', label: activity.workspace }]; // no task to open (#292)
      const task = taskOfActivity(state, terminal.activityId);
      return task ? [{ id: terminal.terminalId, taskId: taskId(task), status: 'terminal', label: taskLabel(task) }] : [];
    });
    // #755: a commands stage's running command, under its task, so the menu bar's Stop reaches it; a terminal's status: it reports none
    const stageLines = state === undefined ? [] : state.activities.flatMap((activity): LivePty[] => {
      const task = activity.commands && taskOfActivity(state, activity.id);
      return activity.commands && task ? [{ id: activity.commands.ptyId, taskId: taskId(task), status: 'terminal', label: taskLabel(task) }] : [];
    });
    res.json({ active: occupied.length + terminals.length + stageLines.length, ptys: [...runLines, ...terminalLines, ...stageLines] });
  });

  // Vite emits assets/*-[hash].js|css: one static mount instead of a route per file. express.static never lists a
  // directory nor leaves UI_DIR. Same position: after the host / origin middleware, so nothing changes for the API.
  // root (not a joined path) so send()'s dotfile check only looks at segments under UI_DIR: a repo checked out
  // under a dot-directory (e.g. a .claude worktree) would otherwise 404 every request, the leading segment
  // of the absolute path always failing containsDotFile.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.set('content-security-policy', pagePolicy(boundPort ?? 0)); // every page and asset below: the port's cookie never reaches another port (#467); frames only from the design frame route (#108). The Host check refused every request before listen bound the port
    next();
  });
  app.get('/', (_req: Request, res: Response) => res.sendFile('index.html', { root: UI_DIR }));
  app.use(express.static(UI_DIR));

  // Express 5 hands a listen error to this callback as well as to 'error': settling here is what makes a taken port reject (#466)
  function bind(port: number): Promise<HttpServer> {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve(server)));
    });
  }

  // The last port first, so the window and the viewer's cookie keep their origin (the view state no longer depends on it, #484); held by
  // another program, or none recorded, the OS picks a free one (#466)
  async function bindFree(port: number | undefined): Promise<HttpServer> {
    if (port === undefined) return bind(0);
    try {
      return await bind(port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      log.info(`port ${port} taken: binding a free one`);
      return bind(0);
    }
  }

  async function listen(port: number | undefined): Promise<number> {
    const server = await bindFree(port);
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : 0;
    httpServer = server;
    // The terminals ride this port too (#407). The socket reads boundPort per upgrade, so nothing is admitted before the line below
    ptySocket = attachPtySocket(server, { ptys, port: () => boundPort, isConfigured: () => live !== undefined, secret: deps.secret, lsp, log });
    boundPort = bound;
    log.info(`listening port=${bound}`);
    // Hive mode (#466): the Runtime is built on the bound port, hooks.json included, before the first dispatch
    if (deps.runtime && deps.state) live = { runtime: await activate(deps.runtime.config, deps.runtime.sources), state: withWorkspaces(deps.state, deps.runtime.config) };
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS); // no-op until configured
    planLimitsTimer = setInterval(() => void refreshPlanLimits(), PLAN_LIMITS_INTERVAL_MS); // no-op until configured or without the dep
    readLoop?.start(); // #180: a round now, then every POLL_INTERVAL_MS
    return bound;
  }

  async function close(reason = 'close'): Promise<void> {
    closing = true;
    if (pollTimer) clearInterval(pollTimer);
    if (planLimitsTimer) clearInterval(planLimitsTimer);
    await readLoop?.stop(); // #180: the running round and every refetch settle first: the database never closes under a transaction
    readModel?.close();
    readModel = undefined; // a second close() closes nothing twice
    githubFlow?.controller.abort(); // a pending login is not a child process; without this it would poll GitHub to expiry after shutdown
    // Every stop path is a Quit (#283): POST /stop (its onStop calls this), SIGTERM and SIGINT (run.ts) and the embedded close. Saved before
    // the kills, so their exits are ignored and the next boot resumes the tasks in flight instead of reporting a crash. Once: a second close()
    // finds cleanStop already set.
    if (live && !live.state.cleanStop) {
      await sleepTerminals(live.runtime);
      wiring.quit(live.state, reason); // #742: once, as the quit itself
      await dispatch({ type: 'quit' });
    }
    held.releaseAll(); // #268: no timer outlives the server, no held Stop hangs
    backoffs.close(); // #805: no retry outlives the server
    keepAwake.stop(); // #226: no power assertion outlives the server
    await pool.killAll(); // children of the Hive: none should outlive it; awaited so the sessions are gone before the process is
    await lsp.stopAll(); // #780: no language server outlives the Hive
    const server = httpServer;
    httpServer = undefined; // a second close() (Electron will-quit after a test's after hook, or vice versa) is a no-op
    if (!server) return;
    ptySocket?.close(); // closeAllConnections() does not reach an upgraded socket: an open terminal would hold server.close() forever (#407)
    ptySocket = undefined;
    server.closeAllConnections(); // drops open SSE streams so close() does not wait for them
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  return { dispatch, poll, boot, refreshPlanLimits, listen, close, getState: () => live?.state };
}
