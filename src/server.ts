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
import { CONFIG_FILE, loadConfigIfPresent, parseConfig } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { reduce, SIGNALS } from './orchestrator.js';
import { formatRateLimits, parseRateLimits } from './rate-limits.js';
import { killStray, renderPrompt, spawnWorker, writePrompt } from './spawn.js';
import { createWorkerPool } from './workers.js';
import { loadState, saveState } from './state-store.js';
import { isTranscriptPath, sumTranscriptTokens } from './usage.js';
import type {
  Board, Config, Effect, EventsPayload, HiveEvent, HookPayload, SetupBody, SetupInfo, SetupResult, Signal, Slot, SpawnWorker, State,
} from './types.js';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 30_000;
const SSE_HEARTBEAT_MS = 25_000;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_NOT_CONFIGURED = 409;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const NOT_CONFIGURED_MESSAGE = 'Hive não configurado: salve o setup primeiro';
const FORBIDDEN_HOST_MESSAGE = 'host não permitido';
const SIGNAL_MESSAGE = `signal must be one of: ${SIGNALS.join(', ')}`;
const SLOT_EMPTY_MESSAGE = 'slot vazio ou inexistente';
const NO_WORKER_MESSAGE = 'nenhum worker vivo nesse slot';
const NO_TAB_MESSAGE = 'esse worker não tem terminal (modo embutido)';
const INPUT_MESSAGE = 'text deve ser uma string não vazia';
const TURN_END_EVENTS: readonly string[] = ['Stop', 'SessionEnd']; // the only stable points to read a transcript

export type BoardFactory = (config: Config) => Board;

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
  /** Setup mode with a config that failed to boot: prefills the form and explains why. */
  setupFallback?: { config: Config; error: string };
}

export interface HiveServer {
  dispatch(event: HiveEvent): Promise<void>;
  poll(): Promise<void>;
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

/** A blank template in the form means "keep what I have"; anything else must be a string (parseConfig validates). */
function promptTemplateFrom(body: Partial<SetupBody>, current: Config | undefined): unknown {
  if (body.promptTemplate === undefined) return current?.promptTemplate;
  if (typeof body.promptTemplate === 'string' && body.promptTemplate.trim() === '') return current?.promptTemplate;
  return body.promptTemplate;
}

const sameBoard = (a: Config, b: Config): boolean => isDeepStrictEqual([a.board, a.status], [b.board, b.status]);

/** Boot-only orphan defense: a worker of a previous Hive may still hold a worktree. Every occupied slot is given as dead right after. */
export async function killStrays(state: State): Promise<void> {
  const slugs = state.slots.flatMap((s) => (s.status !== 'vazio' && s.slug ? [s.slug] : []));
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
  const boardFactory: BoardFactory = deps.boardFactory ?? ((config) => createBoard(config, { repo }));
  const pool = createWorkerPool(deps.spawnWorker ?? spawnWorker);
  let live: Live | undefined = deps.runtime && deps.state ? { runtime: deps.runtime, state: deps.state } : undefined;
  let boundPort: number | undefined;
  let httpServer: HttpServer | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  const clients = new Set<Response>();
  let saveChain: Promise<void> = Promise.resolve();
  let setupChain: Promise<void> = Promise.resolve();

  function eventsPayload(): EventsPayload {
    return live?.state ?? { configured: false };
  }

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
      .catch((err: Error) => console.error('persist failed:', err.message));
    return saveChain;
  }

  async function dispatch(event: HiveEvent): Promise<void> {
    if (!live) return;
    const result = reduce(live.state, event);
    live = { runtime: live.runtime, state: result.state };
    await persist();
    broadcast();
    for (const effect of result.effects) await runEffect(effect);
  }

  async function fail(context: string, err: unknown): Promise<void> {
    const message = `${context}: ${errorMessage(err)}`;
    console.error(message);
    await dispatch({ type: 'error', message });
  }

  async function runEffect(effect: Effect): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    switch (effect.type) {
      case 'setStatus':
        await runtime.board.setStatus(effect.itemId, effect.key).catch((err) => fail(`board.setStatus(${effect.key})`, err));
        return;
      case 'kill':
        // unknown to the pool (started by a previous Hive): nothing to signal, free the slot ourselves
        if (!pool.kill(effect.workerId)) await dispatch({ type: 'exit', workerId: effect.workerId });
        return;
      case 'spawn':
        await spawn(runtime, effect.slot).catch((err) => fail(`spawn ${effect.slot.slug}`, err));
        return;
    }
  }

  async function spawn(runtime: Runtime, slot: Slot): Promise<void> {
    if (!slot.task || !slot.slug || !slot.workerId) return;
    const { config, hooksPath, promptsDir } = runtime;
    const { workerId } = slot;
    const prompt = renderPrompt(config.promptTemplate, slot.task);
    const promptPath = await writePrompt(promptsDir, slot.slug, prompt); // a record for embedded workers, the input for a tab
    pool.start({
      workerId,
      launch: {
        mode: config.workers, workerId, slug: slot.slug, repo, port: config.port, hooksPath, promptPath, prompt,
        claudeArgs: config.claudeArgs,
      },
      onExit: () => void dispatch({ type: 'exit', workerId }),
      onResult: (workerId, text) => void onTurnEnd(workerId, text),
    });
  }

  // A turn ended. With the PR open the task is done: closing stdin lets the worker exit and free the slot.
  // Without a PR nothing happens until someone types (print mode asks in text and stops), so the final text
  // becomes the pending question. Stop arrives before this (hooks block the turn end), so idle wins.
  async function onTurnEnd(workerId: string, text: string): Promise<void> {
    if (live?.state.slots.find((s) => s.workerId === workerId)?.status === 'aguardando_review') {
      pool.end(workerId);
      return;
    }
    await dispatch({ type: 'idle', workerId, question: text });
  }

  async function poll(): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    try {
      const tasks = await runtime.board.listQueue();
      await dispatch({ type: 'poll', tasks });
    } catch (err) {
      await fail('board.listQueue', err);
    }
  }

  async function resolveBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current']);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // Reads the transcript only at a turn end, only for a worker this Hive spawned, and only an absolute `.jsonl`:
  // any local process can hit /hooks/event, and the worst case here is reading a `.jsonl` and discarding it.
  async function turnTokens(workerId: string, payload: HookPayload): Promise<number | undefined> {
    if (!TURN_END_EVENTS.includes(payload.hook_event_name) || !isTranscriptPath(payload.transcript_path)) return undefined;
    const slot = live?.state.slots.find((s) => s.workerId === workerId);
    if (!slot || slot.status === 'vazio') return undefined;
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
    return { config: effective, board, hiveDir, hooksPath, promptsDir };
  }

  async function configure(config: Config): Promise<void> {
    if (live) throw new Error('Hive já configurado: use reconfigure()');
    const runtime = await activate(config);
    const saved = await loadState(runtime.hiveDir, config.maxConcurrent);
    // Empty queue on boot: setMax's fill would otherwise spawn off a stale pre-restart
    // queue. The poll() below refills from the board, which is the source of truth.
    live = { runtime, state: { ...saved, queue: [] } };
    await killStrays(saved);
    await dispatch({ type: 'boot' });
    if (saved.maxConcurrent !== config.maxConcurrent) await dispatch({ type: 'setMax', max: config.maxConcurrent });
    if (!isDeepStrictEqual(saved.budget, config.budget)) await dispatch({ type: 'setBudget', budget: config.budget });
    if (!isDeepStrictEqual(saved.usageRules, config.usageRules)) await dispatch({ type: 'setUsageRules', usageRules: config.usageRules });
    await poll();
  }

  async function reconfigure(config: Config): Promise<void> {
    if (!live) throw new Error('Hive não configurado: use configure()');
    const runtime = await activate(config, live.runtime);
    live = { runtime, state: live.state };
    if (live.state.maxConcurrent !== config.maxConcurrent) await dispatch({ type: 'setMax', max: config.maxConcurrent });
    if (!isDeepStrictEqual(live.state.budget, config.budget)) await dispatch({ type: 'setBudget', budget: config.budget });
    if (!isDeepStrictEqual(live.state.usageRules, config.usageRules)) {
      await dispatch({ type: 'setUsageRules', usageRules: config.usageRules });
    }
    await poll();
  }

  async function writeConfigFile(config: Config): Promise<void> {
    const path = join(repo, CONFIG_FILE);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + '\n');
    await rename(tmp, path);
  }

  function requireLive(res: Response): Live | undefined {
    if (!live) res.status(HTTP_NOT_CONFIGURED).json({ error: NOT_CONFIGURED_MESSAGE });
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
    next();
  });

  // Answers only after the dispatch: the worker's hook blocks until curl returns, so the state (a PR seen on
  // PostToolUse, above all) is applied before the worker goes on and its `result` line reaches endWhenReviewed.
  app.post('/hooks/event', async (req: Request, res: Response) => {
    const workerId = req.header('x-hive-worker');
    const payload = req.body as HookPayload | undefined;
    if (workerId && payload?.hook_event_name) {
      const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
      const tokens = await turnTokens(workerId, payload);
      await dispatch({ type: 'hook', workerId, payload, branch, tokens });
    }
    res.sendStatus(200);
  });

  // A tab's command ends with a curl here (embedded workers exit through the process). Unknown to the pool
  // (started by a previous Hive): free the slot ourselves.
  app.post('/hooks/exit', async (req: Request, res: Response) => {
    res.sendStatus(200);
    const workerId = req.header('x-hive-worker');
    if (workerId && !pool.exit(workerId)) await dispatch({ type: 'exit', workerId });
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
    res.send(formatRateLimits(rateLimits)); // from the payload, not the State: an unknown worker gets the line and the reducer ignores it
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
    const info: SetupInfo = live
      ? { configured: true, repo, config: live.runtime.config }
      : { configured: false, repo, ...deps.setupFallback };
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
    let config: Config;
    try {
      config = parseConfig({ board: boardFromQuery(req.query) }); // defaults fill the rest; only the board matters here
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    try {
      res.json(await boardFactory(config).setupOptions());
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
      const current = await loadConfigIfPresent(repo);
      config = parseConfig({
        board: body.board,
        status: body.status,
        maxConcurrent: body.maxConcurrent,
        port: current?.port,
        claudeArgs: current?.claudeArgs,
        workers: body.workers ?? current?.workers,
        promptTemplate: promptTemplateFrom(body, current),
        budget: body.budget ?? current?.budget,
        usageRules: body.usageRules ?? current?.usageRules,
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

  app.get('/slots/:id/output', (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot || slot.status === 'vazio') {
      res.status(HTTP_NOT_FOUND).json({ error: SLOT_EMPTY_MESSAGE });
      return;
    }
    res.json({ lines: slot.workerId ? pool.output(slot.workerId) : [] });
  });

  app.post('/slots/:id/input', (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const text = (req.body as { text?: unknown }).text;
    if (typeof text !== 'string' || text.trim() === '') {
      res.status(HTTP_BAD_REQUEST).json({ error: INPUT_MESSAGE });
      return;
    }
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot?.workerId || !pool.send(slot.workerId, text)) {
      res.status(HTTP_NOT_FOUND).json({ error: NO_WORKER_MESSAGE });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/slots/:id/focus', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    try {
      if (!slot?.workerId || !(await pool.focus(slot.workerId))) {
        res.status(HTTP_NOT_FOUND).json({ error: NO_TAB_MESSAGE });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
    }
  });

  app.post('/board/refresh', async (_req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await poll();
    res.json({ ok: true });
  });

  app.get('/', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'index.html')));
  app.get('/ui/app.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'app.js')));
  app.get('/ui/limits.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'limits.js')));

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
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS); // no-op until configured
    return bound;
  }

  async function close(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    pool.killAll(); // children of the Hive: none should outlive it
    const server = httpServer;
    httpServer = undefined; // a second close() (Electron will-quit after a test's after hook, or vice versa) is a no-op
    if (!server) return;
    server.closeAllConnections(); // drops open SSE streams so close() does not wait for them
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  return { dispatch, poll, listen, close, configure, reconfigure, getState: () => live?.state };
}
