import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createBoard } from './board.js';
import { listProjects } from './boards/github.js';
import { createMarkdownFileIfMissing, markdownPath } from './boards/markdown.js';
import { cardOf, citedColumns } from './cards.js';
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfigOrLegacy, parseBoard, parseConfig } from './config.js';
import { HIVE_DIR, prepareHiveDir } from './hooks-settings.js';
import { createLogger, describeChanges, describeColumns, describeEffect, describeEvent, type Logger } from './log.js';
import { isChildSession, reduce, SIGNALS } from './orchestrator.js';
import { PLAN_LIMITS_INTERVAL_MS } from './plan-limits.js';
import { POLL_INTERVAL_MS, shouldPoll } from './polling.js';
import { formatRateLimits, parseRateLimits } from './rate-limits.js';
import { registerCardRoutes } from './server-cards.js';
import { killStray, renderPrompt, spawnWorker, workerArgs, writePrompt } from './spawn.js';
import { tailTranscript } from './transcript.js';
import { createWorkerPool } from './workers.js';
import { loadState, saveState } from './state-store.js';
import { isTranscriptPath, isWorkerTranscript, sumTranscriptTokens } from './usage.js';
import type {
  Board, BoardSpec, Config, Effect, EventsPayload, HiveEvent, HookPayload, Language, PlanLimitsReader, SetupBody, SetupInfo, SetupResult, Signal, Slot,
  SpawnWorker, State,
} from './types.js';

const execFileAsync = promisify(execFile);
const SSE_HEARTBEAT_MS = 25_000;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409; // not configured, or the state refuses what was asked
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_NO_CONTENT = 204; // hook routes: an empty body is "no decision" for Claude Code
const NOT_CONFIGURED_MESSAGE = 'Hive não configurado: salve o setup primeiro';
const FORBIDDEN_HOST_MESSAGE = 'host não permitido';
const FORBIDDEN_ORIGIN_MESSAGE = 'origem não permitida';
const HOOKS_PREFIX = '/hooks/';
export const UI_HEADER = 'x-hive-ui'; // every dashboard POST carries it; the value is irrelevant
const SIGNAL_MESSAGE = `signal must be one of: ${SIGNALS.join(', ')}`;
const SLOT_EMPTY_MESSAGE = 'slot vazio ou inexistente';
const NO_WORKER_MESSAGE = 'nenhum worker vivo nesse slot';
const TURN_END_EVENTS: readonly string[] = ['Stop', 'SessionEnd']; // the only stable points to read a transcript

export type BoardFactory = (spec: BoardSpec) => Board;

export interface Runtime {
  config: Config;
  board: Board;
  hiveDir: string;
  hooksPath: string;
  promptsDir: string;
}

export interface ServerDeps {
  repo: string;
  runtime?: Runtime;
  state?: State;
  boardFactory?: BoardFactory;
  spawnWorker?: SpawnWorker; // tests inject a fake; the default opens a real claude
  log?: Logger; // tests inject a fake; the default writes <repo>/.hive/hive.log
  /** The Hive's own reading of the plan limits; absent (every test) means it never reads. main.ts / run.ts inject the real one. */
  readPlanLimits?: PlanLimitsReader;
  /** Setup mode with a config that failed to boot: prefills the form and explains why. */
  setupFallback?: { config: Config; error: string };
  systemLanguage?: Language; // from the locale the boot saw; default en. The config's language wins when set
}

export interface HiveServer {
  dispatch(event: HiveEvent): Promise<void>;
  poll(): Promise<void>;
  refreshPlanLimits(): Promise<void>;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  configure(config: Config): Promise<void>;
  reconfigure(config: Config): Promise<void>;
  getState(): State | undefined;
}

interface Live {
  runtime: Runtime;
  state: State;
}

// epics is baked into the GitHub adapter at creation, so a change needs a new instance like a change of board or columns.
const sameBoard = (a: Config, b: Config): boolean => isDeepStrictEqual([a.board, citedColumns(a.columns), a.epics], [b.board, citedColumns(b.columns), b.epics]);

/** Boot-only orphan defense: a worker of a previous Hive may still hold a worktree. Every occupied slot is given as dead right after. */
export async function killStrays(state: State): Promise<void> {
  const slugs = state.cards.flatMap((c) => (c.slotId ? [c.slug] : []));
  await Promise.all(slugs.map((slug) => killStray(slug)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Query values are strings: `number` is converted, the rest goes to parseConfig as is so it names the bad field.
function boardFromQuery(query: Request['query']): Record<string, unknown> {
  const { type, owner, number, path } = query;
  return { type, owner, path, number: typeof number === 'string' && number !== '' ? Number(number) : number };
}

export function createServer(deps: ServerDeps): HiveServer {
  const { repo } = deps;
  const log = deps.log ?? createLogger(join(repo, HIVE_DIR));
  const systemLanguage = deps.systemLanguage ?? 'en';
  const boardFactory: BoardFactory = deps.boardFactory ?? ((spec) => createBoard(spec, { repo, log }));
  const pool = createWorkerPool(deps.spawnWorker ?? spawnWorker);
  let live: Live | undefined = deps.runtime && deps.state ? { runtime: deps.runtime, state: deps.state } : undefined;
  let boundPort: number | undefined;
  let httpServer: HttpServer | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let planLimitsTimer: NodeJS.Timeout | undefined;
  let planLimitsReason: string | undefined; // last failure logged; a repeat is silent, a change and the recovery are one line each
  const clients = new Set<Response>();
  let saveChain: Promise<void> = Promise.resolve();
  let setupChain: Promise<void> = Promise.resolve();

  function eventsPayload(): EventsPayload {
    return live?.state ?? { configured: false };
  }

  const slotOf = (workerId: string): Slot | undefined => live?.state.slots.find((s) => s.workerId === workerId);

  // What the UI and the status line speak: the saved config's language, else the system's. Setup mode reads the fallback config too.
  const effectiveLanguage = (): Language => (live?.runtime.config ?? deps.setupFallback?.config)?.language ?? systemLanguage;

  function broadcast(): void {
    const data = `data: ${JSON.stringify(eventsPayload())}\n\n`;
    for (const res of clients) res.write(data);
  }

  // Serializes writes: dispatch calls can overlap (a hook arriving mid-poll, a worker exit landing
  // inside a kill effect), and two concurrent saveState calls would race on the same state.json.tmp.
  // Chaining onto saveChain queues them, and reading `live` inside the .then ensures a queued save
  // always persists the latest.
  function persist(): Promise<void> {
    saveChain = saveChain
      .then(() => (live ? saveState(live.runtime.hiveDir, live.state) : undefined))
      .catch((err: Error) => log.error(`persist failed: ${err.message}`));
    return saveChain;
  }

  async function dispatch(event: HiveEvent): Promise<void> {
    if (!live) return;
    log.debug(describeEvent(event));
    const prev = live.state;
    const result = reduce(prev, event);
    live = { runtime: live.runtime, state: result.state };
    // Transitions are derived here, not in the reducer: one place covers every rule, current or future, and the reducer stays pure.
    for (const line of describeChanges(prev, result.state)) log.info(line);
    if (result.effects.length > 0) log.debug(`effects: ${result.effects.map(describeEffect).join('; ')}`);
    await persist();
    broadcast();
    for (const effect of result.effects) await runEffect(effect);
  }

  async function fail(context: string, err: unknown): Promise<void> {
    const message = `${context}: ${errorMessage(err)}`;
    log.error(message);
    await dispatch({ type: 'error', message });
  }

  async function runEffect(effect: Effect): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    switch (effect.type) {
      case 'setColumn':
        await runtime.board.setColumn(effect.itemId, effect.column)
          .then(() => log.info(`${describeEffect(effect)} ok`))
          .catch((err) => fail(`board.setColumn(${effect.column})`, err));
        return;
      case 'kill':
        log.info(describeEffect(effect));
        // unknown to the pool (started by a previous Hive): nothing to signal, free the slot ourselves
        if (!pool.kill(effect.workerId)) await dispatch({ type: 'exit', workerId: effect.workerId });
        return;
      case 'spawn':
        log.info(describeEffect(effect));
        await spawn(runtime, effect).catch((err) => fail(`spawn ${effect.card.slug}`, err));
        return;
    }
  }

  async function spawn(runtime: Runtime, effect: Extract<Effect, { type: 'spawn' }>): Promise<void> {
    const { slot: { workerId }, card, column, session } = effect;
    if (!workerId) return;
    const { config, hooksPath, promptsDir } = runtime;
    const promptPath = await writePrompt(promptsDir, card.slug, renderPrompt(column.prompt ?? '', card.task)); // the command line reads it
    pool.start({
      workerId,
      launch: { mode: config.workers, workerId, slug: card.slug, repo, port: config.port, hooksPath, promptPath, args: workerArgs(card, column, session, config.claudeArgs) },
      onExit: () => void dispatch({ type: 'exit', workerId }),
      onError: (message) => void fail(`worker ${card.slug}`, new Error(message)), // tmux / iTerm missing or refused: the error bar
    });
  }

  async function poll(): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    try {
      const cards = await runtime.board.listCards();
      log.info(`poll cards=${cards.length}`);
      await dispatch({ type: 'poll', cards });
    } catch (err) {
      await fail('board.listCards', err);
    }
    await refreshQuota(runtime.board); // after every real poll, success or failure: the reset time matters most when the limit just hit
  }

  // Diagnostic only: a failed read is logged and never masks the board error or drops the poll.
  async function refreshQuota(board: Board): Promise<void> {
    try {
      const quota = await board.quota?.();
      if (quota) await dispatch({ type: 'boardQuota', quota });
    } catch (err) {
      log.error(`board.quota: ${errorMessage(err)}`);
    }
  }

  // A failure keeps the last value and is logged once per reason: an API-key user (no OAuth token) sees it in hive.log once, not
  // every 5 min. Info, not error: nothing is broken. The reader's message never carries the token or the response body.
  async function refreshPlanLimits(): Promise<void> {
    const read = deps.readPlanLimits;
    if (!read || !live) return;
    try {
      const rateLimits = await read();
      if (planLimitsReason !== undefined) log.info('plan limits: ok');
      planLimitsReason = undefined;
      if (rateLimits) await dispatch({ type: 'rateLimits', rateLimits });
    } catch (err) {
      const reason = errorMessage(err);
      if (reason !== planLimitsReason) log.info(`plan limits: ${reason}`);
      planLimitsReason = reason;
    }
  }

  // Only the timer asks shouldPoll; /board/refresh, configure, reconfigure and boot always poll: whoever asked wants the answer now.
  async function tick(): Promise<void> {
    if (live && shouldPoll(live.state, Date.now())) await poll();
  }

  async function resolveBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current']);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // Any local process can hit /hooks/event: a transcript path is honoured only when it is the worker's own, so a forged
  // SessionStart cannot turn GET /slots/:id/output into a reader of any `.jsonl` the Hive can open. Dropped, not rejected:
  // the rest of the hook (status, branch) still applies.
  function scopeTranscript(workerId: string, payload: HookPayload): HookPayload {
    const slot = slotOf(workerId);
    const slug = slot && live ? cardOf(live.state.cards, slot)?.slug : undefined;
    if (payload.transcript_path === undefined || (slug !== undefined && isWorkerTranscript(payload.transcript_path, repo, slug))) return payload;
    return { ...payload, transcript_path: undefined };
  }

  // Reads the transcript only at a turn end, only for a worker this Hive spawned, and only the worker's own `.jsonl` (scopeTranscript).
  async function turnTokens(workerId: string, payload: HookPayload): Promise<number | undefined> {
    if (!TURN_END_EVENTS.includes(payload.hook_event_name) || !isTranscriptPath(payload.transcript_path)) return undefined;
    const slot = slotOf(workerId);
    if (!slot || slot.status === 'empty') return undefined;
    return sumTranscriptTokens(payload.transcript_path).catch(() => undefined); // unreadable: the hook goes through without tokens
  }

  // Builds a Runtime for `config` on the port actually in use: hooks.json and the worker
  // command must target the listening port even when the saved file asks for another one.
  // Same board and status as the live runtime → same board instance, so a write already in flight keeps its chain.
  async function activate(config: Config, current?: Runtime): Promise<Runtime> {
    if (boundPort === undefined) throw new Error('listen() precisa rodar antes de configure()');
    const effective: Config = { ...config, port: boundPort };
    const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, boundPort);
    const board = current && sameBoard(current.config, effective) ? current.board : boardFactory(effective);
    await board.resolveFields();
    log.setLevel(effective.logLevel); // read from the file on every save: a hand edit switches the level without a restart
    log.info(`config port=${boundPort} board=${effective.board.type} workers=${effective.workers} logLevel=${effective.logLevel} columns=${describeColumns(effective.columns)}`);
    return { config: effective, board, hiveDir, hooksPath, promptsDir };
  }

  async function configure(config: Config): Promise<void> {
    if (live) throw new Error('Hive já configurado: use reconfigure()');
    const runtime = await activate(config);
    const saved = await loadState(runtime.hiveDir, config.maxConcurrent);
    // columns come from the config; cards from the saved state are re-listed by the poll() below, which is the source of truth
    live = { runtime, state: { ...saved, columns: config.columns } };
    await killStrays(saved);
    await dispatch({ type: 'boot' });
    if (!isDeepStrictEqual(saved.budget, config.budget)) await dispatch({ type: 'setBudget', budget: config.budget });
    if (!isDeepStrictEqual(saved.usageRules, config.usageRules)) await dispatch({ type: 'setUsageRules', usageRules: config.usageRules });
    await poll();
    await refreshPlanLimits();
  }

  async function reconfigure(config: Config): Promise<void> {
    if (!live) throw new Error('Hive não configurado: use configure()');
    const runtime = await activate(config, live.runtime);
    live = { runtime, state: live.state };
    if (!isDeepStrictEqual(live.state.budget, config.budget)) await dispatch({ type: 'setBudget', budget: config.budget });
    if (!isDeepStrictEqual(live.state.usageRules, config.usageRules)) {
      await dispatch({ type: 'setUsageRules', usageRules: config.usageRules });
    }
    if (!isDeepStrictEqual(live.state.columns, config.columns)) await dispatch({ type: 'setColumns', columns: config.columns });
    await poll();
  }

  async function writeConfigFile(config: Config): Promise<void> {
    const path = join(repo, CONFIG_FILE);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
    await rename(tmp, path);
  }

  function requireLive(res: Response): Live | undefined {
    if (!live) res.status(HTTP_CONFLICT).json({ error: NOT_CONFIGURED_MESSAGE });
    return live;
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Rejects DNS-rebinding / cross-origin requests that don't target this exact bound
  // address: hooks and the UI always call http://127.0.0.1:<port> or localhost:<port>.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const allowedHosts = boundPort !== undefined ? [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`] : [];
    if (!allowedHosts.includes(req.headers.host ?? '')) {
      res.status(HTTP_FORBIDDEN).json({ error: FORBIDDEN_HOST_MESSAGE });
      return;
    }
    // The Host check does not stop CSRF: a form on any site can post straight at the local port. Dashboard routes need a
    // header only the UI sends; a form cannot set one, and a cross-origin fetch that does hits a preflight the server never
    // answers. Hook routes stay open: without x-hive-worker they are no-ops already.
    if (req.method === 'POST' && !req.path.startsWith(HOOKS_PREFIX) && req.header(UI_HEADER) === undefined) {
      res.status(HTTP_FORBIDDEN).json({ error: FORBIDDEN_ORIGIN_MESSAGE });
      return;
    }
    next();
  });

  // Answers only after the dispatch: the worker's hook blocks until curl returns, so a PR seen on PostToolUse is applied before the worker goes on.
  app.post('/hooks/event', async (req: Request, res: Response) => {
    const workerId = req.header('x-hive-worker');
    const raw = req.body as HookPayload | undefined;
    const payload = workerId && raw?.hook_event_name ? scopeTranscript(workerId, raw) : raw;
    // Computed once against the slot as it stands: a subagent/teammate Stop or SessionEnd must not read the transcript, same as the reducer ignores it (#24)
    const isChild = workerId !== undefined && payload !== undefined && isChildSession(slotOf(workerId), payload);
    if (workerId && payload?.hook_event_name) {
      const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
      const tokens = isChild ? undefined : await turnTokens(workerId, payload);
      await dispatch({ type: 'hook', workerId, payload, branch, tokens });
    } else {
      log.debug(`hook ignored: ${workerId ? 'no event name' : 'no worker id'}`);
    }
    res.sendStatus(200);
  });

  // The worker's command line ends with a curl here (both modes). Unknown to the pool (started by a previous Hive): free the slot ourselves.
  app.post('/hooks/exit', async (req: Request, res: Response) => {
    res.sendStatus(200);
    const workerId = req.header('x-hive-worker');
    if (workerId && !pool.exit(workerId)) await dispatch({ type: 'exit', workerId });
  });

  // The worker's own word that the command is finished (the trailer's curl): the next Stop of this run ends the stage.
  app.post('/hooks/done', async (req: Request, res: Response) => {
    res.status(HTTP_NO_CONTENT).end();
    const workerId = req.header('x-hive-worker');
    if (workerId) await dispatch({ type: 'done', workerId });
  });

  // The worker's status line posts its whole JSON here; only `rate_limits` is kept, and the reply is the line the worker's tab shows.
  app.post('/hooks/status', async (req: Request, res: Response) => {
    res.type('text/plain');
    const workerId = req.header('x-hive-worker');
    const rateLimits = parseRateLimits(req.body, new Date());
    if (!workerId || !rateLimits) {
      res.send('');
      return;
    }
    res.send(formatRateLimits(rateLimits, effectiveLanguage())); // from the payload, not the State: an unknown worker gets the line and the reducer ignores it
    await dispatch({ type: 'rateLimits', workerId, rateLimits });
  });

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

  app.get('/setup', (_req: Request, res: Response) => {
    const language = effectiveLanguage();
    const info: SetupInfo = live
      ? { configured: true, repo, config: live.runtime.config, language }
      : { configured: false, repo, ...deps.setupFallback, language };
    res.json(info);
  });

  app.get('/setup/projects', async (req: Request, res: Response) => {
    const owner = req.query.owner;
    if (typeof owner !== 'string' || owner === '') {
      res.status(HTTP_BAD_REQUEST).json({ error: 'owner obrigatório' });
      return;
    }
    try {
      res.json(await listProjects(owner));
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });

  app.get('/setup/columns', async (req: Request, res: Response) => {
    let spec: BoardSpec;
    try {
      spec = { board: parseBoard(boardFromQuery(req.query), 'board'), columns: [], epics: DEFAULT_CONFIG.epics }; // only the board matters here
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    try {
      res.json(await boardFactory(spec).setupOptions());
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });

  // Serializes saves: two concurrent POST /setup would race on hive.config.json.tmp and
  // into configure()/reconfigure(). Chaining queues them in arrival order; each request
  // awaits its own link, and the chain never rejects because saveSetup answers every error.
  app.post('/setup', (req: Request, res: Response) => {
    const run = (): Promise<void> => saveSetup((req.body ?? {}) as Partial<SetupBody>, res);
    setupChain = setupChain.then(run, run);
    return setupChain;
  });

  async function saveSetup(body: Partial<SetupBody>, res: Response): Promise<void> {
    let config: Config;
    try {
      const current = await loadConfigOrLegacy(repo);
      config = parseConfig({
        board: body.board, columns: body.columns ?? current?.columns,
        maxConcurrent: body.maxConcurrent ?? current?.maxConcurrent,
        port: current?.port,
        claudeArgs: current?.claudeArgs,
        workers: body.workers ?? current?.workers,
        epics: body.epics ?? current?.epics,
        logLevel: current?.logLevel, // never in the body: the file is the switch
        budget: body.budget ?? current?.budget,
        usageRules: body.usageRules ?? current?.usageRules,
        language: body.language ?? current?.language, // the form always sends it; an API caller that omits it keeps the saved one
      });
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    // The only write allowed before validation: a markdown board that does not exist yet gets the header and an example row.
    if (config.board.type === 'markdown') {
      try {
        await createMarkdownFileIfMissing(markdownPath(repo, config.board.path));
      } catch (err) {
        res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
        return;
      }
    }
    try {
      await boardFactory(config).resolveFields(); // validates against the real board before the config is written
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    try {
      await writeConfigFile(config);
      log.info('setup saved');
      await (live ? reconfigure(config) : configure(config));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
      return;
    }
    const result: SetupResult = config.port === boundPort ? { ok: true } : { ok: true, restartForPort: config.port };
    res.json(result);
  }

  app.post('/config', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const max = (req.body as { maxConcurrent?: unknown }).maxConcurrent;
    if (!Number.isInteger(max) || (max as number) < 0) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'maxConcurrent must be a non-negative integer' });
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

  app.post('/slots/:id/kill', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await dispatch({ type: 'kill', slotId: req.params.id as string });
    res.json({ ok: true });
  });

  // The excerpt is the tail of the transcript SessionStart reported, read on every call: nothing is kept in memory.
  // Unreadable (rotated, not written yet) is an empty excerpt, not an error.
  app.get('/slots/:id/output', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot || slot.status === 'empty') {
      res.status(HTTP_NOT_FOUND).json({ error: SLOT_EMPTY_MESSAGE });
      return;
    }
    res.json({ lines: slot.transcriptPath ? await tailTranscript(slot.transcriptPath).catch(() => []) : [] });
  });

  app.post('/slots/:id/focus', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    try {
      if (!slot?.workerId || !(await pool.focus(slot.workerId))) {
        res.status(HTTP_NOT_FOUND).json({ error: NO_WORKER_MESSAGE });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) }); // the terminal could not open: the message is the one the OS gave
    }
  });

  registerCardRoutes(app, { requireLive, dispatch }); // start, close, keep: same host/origin middleware ordering, registered here

  app.post('/board/refresh', async (_req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await poll();
    res.json({ ok: true });
  });

  // Vite emits assets/*-[hash].js|css: one static mount instead of a route per file. express.static never lists a
  // directory nor leaves UI_DIR. Same position: after the host / origin middleware, so nothing changes for the API.
  // root (not a joined path) so send()'s dotfile check only looks at segments under UI_DIR: a repo checked out
  // under a dot-directory (e.g. a .claude worktree) would otherwise 404 every request, the leading segment
  // of the absolute path always failing containsDotFile.
  app.get('/', (_req: Request, res: Response) => res.sendFile('index.html', { root: UI_DIR }));
  app.use(express.static(UI_DIR));

  async function listen(port: number): Promise<number> {
    const bound = await new Promise<number>((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`porta ${port} em uso (outro Agent Hive rodando? veja: lsof -i :${port})`)
          : err);
      });
      httpServer = server;
    });
    boundPort = bound;
    log.info(`listening port=${bound}`);
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS); // no-op until configured
    planLimitsTimer = setInterval(() => void refreshPlanLimits(), PLAN_LIMITS_INTERVAL_MS); // no-op until configured or without the dep
    return bound;
  }

  async function close(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    if (planLimitsTimer) clearInterval(planLimitsTimer);
    pool.killAll(); // children of the Hive: none should outlive it
    const server = httpServer;
    httpServer = undefined; // a second close() (Electron will-quit after a test's after hook, or vice versa) is a no-op
    if (!server) return;
    server.closeAllConnections(); // drops open SSE streams so close() does not wait for them
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  return { dispatch, poll, refreshPlanLimits, listen, close, configure, reconfigure, getState: () => live?.state };
}
