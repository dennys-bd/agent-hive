import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createBoard } from './board.js';
import { listProjects, listStatusOptions } from './boards/github.js';
import { CONFIG_FILE, loadConfigIfPresent, parseConfig } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { reduce } from './orchestrator.js';
import { aliveSlugs, focusWorker, killWorker, openWorker, renderPrompt, workerCommand, writePrompt } from './spawn.js';
import { loadState, saveState } from './state-store.js';
import type {
  Board, Config, Effect, EventsPayload, HiveEvent, HookPayload, SetupBody, SetupInfo, SetupResult, Slot, State,
} from './types.js';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 30_000;
const SSE_HEARTBEAT_MS = 25_000;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_CONFIGURED = 409;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const NOT_CONFIGURED_MESSAGE = 'Hive não configurado: salve o setup primeiro';
const FORBIDDEN_HOST_MESSAGE = 'host não permitido';

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

export async function detectAlive(state: State): Promise<string[]> {
  return aliveSlugs(state.slots.flatMap((s) => (s.status !== 'vazio' && s.slug ? [s.slug] : [])));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createServer(deps: ServerDeps): HiveServer {
  const { repo } = deps;
  const boardFactory: BoardFactory = deps.boardFactory ?? ((config) => createBoard(config, { repo }));
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

  // Serializes writes: dispatch calls can overlap (a hook arriving mid-poll, or the
  // nested `spawned` dispatch inside spawn()), and two concurrent saveState calls
  // would race on the same state.json.tmp. Chaining onto saveChain queues them, and
  // reading `live` inside the .then ensures a queued save always persists the latest.
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
        try {
          // no live process (tab closed by hand, exit signal lost): free the slot ourselves
          const matched = await killWorker(effect.slug);
          if (!matched) await dispatch({ type: 'exit', workerId: effect.workerId });
        } catch (err) {
          await fail('kill', err);
        }
        return;
      case 'spawn':
        await spawn(runtime, effect.slot).catch((err) => fail(`spawn ${effect.slot.slug}`, err));
        return;
    }
  }

  async function spawn(runtime: Runtime, slot: Slot): Promise<void> {
    if (!slot.task || !slot.slug || !slot.workerId) return;
    const { config, hooksPath, promptsDir } = runtime;
    const promptPath = await writePrompt(promptsDir, slot.slug, renderPrompt(config.promptTemplate, slot.task));
    const command = workerCommand({
      repo, workerId: slot.workerId, port: config.port, slug: slot.slug, hooksPath, promptPath, claudeArgs: config.claudeArgs,
    });
    const itermSessionId = await openWorker(command);
    await dispatch({ type: 'spawned', workerId: slot.workerId, itermSessionId });
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

  // Builds a Runtime for `config` on the port actually in use: hooks.json and the worker
  // command must target the listening port even when the saved file asks for another one.
  async function activate(config: Config): Promise<Runtime> {
    if (boundPort === undefined) throw new Error('listen() precisa rodar antes de configure()');
    const effective: Config = { ...config, port: boundPort };
    const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, boundPort);
    const board = boardFactory(effective);
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
    await dispatch({ type: 'boot', aliveSlugs: await detectAlive(saved) });
    if (saved.maxConcurrent !== config.maxConcurrent) await dispatch({ type: 'setMax', max: config.maxConcurrent });
    await poll();
  }

  async function reconfigure(config: Config): Promise<void> {
    if (!live) throw new Error('Hive não configurado: use configure()');
    const runtime = await activate(config);
    live = { runtime, state: live.state };
    if (live.state.maxConcurrent !== config.maxConcurrent) await dispatch({ type: 'setMax', max: config.maxConcurrent });
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

  app.post('/hooks/event', async (req: Request, res: Response) => {
    res.sendStatus(200);
    const workerId = req.header('x-hive-worker');
    const payload = req.body as HookPayload | undefined;
    if (!workerId || !payload?.hook_event_name) return;
    const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
    await dispatch({ type: 'hook', workerId, payload, branch });
  });

  app.post('/hooks/exit', async (req: Request, res: Response) => {
    res.sendStatus(200);
    const workerId = req.header('x-hive-worker');
    if (workerId) await dispatch({ type: 'exit', workerId });
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
      : { configured: false, repo };
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
    const { owner, number } = req.query;
    const parsed = typeof number === 'string' && number !== '' ? Number(number) : Number.NaN;
    if (typeof owner !== 'string' || owner === '' || !Number.isInteger(parsed) || parsed < 0) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'owner e number obrigatórios' });
      return;
    }
    try {
      res.json(await listStatusOptions(owner, parsed));
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
        promptTemplate: promptTemplateFrom(body, current),
      });
      await boardFactory(config).resolveFields(); // validates columns against the real board before anything is written
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

  app.post('/slots/:id/kill', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await dispatch({ type: 'kill', slotId: req.params.id as string });
    res.json({ ok: true });
  });

  app.post('/slots/:id/focus', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot?.itermSessionId) {
      res.status(404).json({ error: 'slot has no terminal session' });
      return;
    }
    try {
      await focusWorker(slot.itermSessionId);
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
    const server = httpServer;
    if (!server) return;
    server.closeAllConnections(); // drops open SSE streams so close() does not wait for them
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  return { dispatch, poll, listen, close, configure, reconfigure, getState: () => live?.state };
}
