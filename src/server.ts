import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import type { Board } from './board.js';
import { reduce } from './orchestrator.js';
import { aliveSlugs, focusWorker, killWorker, openWorker, renderPrompt, workerCommand, writePrompt } from './spawn.js';
import { saveState } from './state-store.js';
import type { Config, Effect, HiveEvent, HookPayload, Slot, State } from './types.js';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 30_000;
const SSE_HEARTBEAT_MS = 25_000;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');

export interface ServerDeps {
  repo: string;
  config: Config;
  board: Board;
  state: State;
  hiveDir: string;
  hooksPath: string;
  promptsDir: string;
}

export interface HiveServer {
  dispatch(event: HiveEvent): Promise<void>;
  poll(): Promise<void>;
  listen(): Promise<void>;
  getState(): State;
}

export async function detectAlive(state: State): Promise<string[]> {
  return aliveSlugs(state.slots.flatMap((s) => (s.status !== 'vazio' && s.slug ? [s.slug] : [])));
}

export function createServer(deps: ServerDeps): HiveServer {
  const { repo, config, board, hiveDir, hooksPath, promptsDir } = deps;
  let state = deps.state;
  const clients = new Set<Response>();
  let saveChain: Promise<void> = Promise.resolve();

  function broadcast(): void {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  // Serializes writes: dispatch calls can overlap (a hook arriving mid-poll, or the
  // nested `spawned` dispatch inside spawn()), and two concurrent saveState calls
  // would race on the same state.json.tmp. Chaining onto saveChain queues them, and
  // reading `state` inside the .then ensures a queued save always persists the latest.
  function persist(): Promise<void> {
    saveChain = saveChain
      .then(() => saveState(hiveDir, state))
      .catch((err: Error) => console.error('persist failed:', err.message));
    return saveChain;
  }

  async function dispatch(event: HiveEvent): Promise<void> {
    const result = reduce(state, event);
    state = result.state;
    await persist();
    broadcast();
    for (const effect of result.effects) await runEffect(effect);
  }

  async function fail(context: string, err: unknown): Promise<void> {
    const message = `${context}: ${(err as Error).message}`;
    console.error(message);
    await dispatch({ type: 'error', message });
  }

  async function runEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'setStatus':
        await board.setStatus(effect.itemId, effect.key).catch((err) => fail(`board.setStatus(${effect.key})`, err));
        return;
      case 'kill':
        await killWorker(effect.slug).catch((err) => fail('kill', err));
        return;
      case 'spawn':
        await spawn(effect.slot).catch((err) => fail(`spawn ${effect.slot.slug}`, err));
        return;
    }
  }

  async function spawn(slot: Slot): Promise<void> {
    if (!slot.task || !slot.slug || !slot.workerId) return;
    const promptPath = await writePrompt(promptsDir, slot.slug, renderPrompt(config.promptTemplate, slot.task));
    const command = workerCommand({
      repo, workerId: slot.workerId, port: config.port, slug: slot.slug, hooksPath, promptPath, claudeArgs: config.claudeArgs,
    });
    const itermSessionId = await openWorker(command);
    await dispatch({ type: 'spawned', workerId: slot.workerId, itermSessionId });
  }

  async function poll(): Promise<void> {
    try {
      const tasks = await board.listQueue();
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

  const app = express();
  app.use(express.json({ limit: '2mb' }));

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
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  app.post('/config', async (req: Request, res: Response) => {
    const max = (req.body as { maxConcurrent?: unknown }).maxConcurrent;
    if (!Number.isInteger(max) || (max as number) < 0) {
      res.status(400).json({ error: 'maxConcurrent must be a non-negative integer' });
      return;
    }
    await dispatch({ type: 'setMax', max: max as number });
    res.json({ ok: true });
  });

  app.post('/slots/:id/kill', async (req: Request, res: Response) => {
    await dispatch({ type: 'kill', slotId: req.params.id as string });
    res.json({ ok: true });
  });

  app.post('/slots/:id/focus', async (req: Request, res: Response) => {
    const slot = state.slots.find((s) => s.id === req.params.id);
    if (!slot?.itermSessionId) {
      res.status(404).json({ error: 'slot has no terminal session' });
      return;
    }
    try {
      await focusWorker(slot.itermSessionId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/board/refresh', async (_req: Request, res: Response) => {
    await poll();
    res.json({ ok: true });
  });

  app.get('/', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'index.html')));
  app.get('/ui/app.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'app.js')));

  async function listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(config.port, '127.0.0.1', () => resolve());
      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`porta ${config.port} em uso (outro Agent Hive rodando? veja: lsof -i :${config.port})`)
          : err);
      });
    });
    setInterval(() => void poll(), POLL_INTERVAL_MS);
  }

  return { dispatch, poll, listen, getState: () => state };
}
