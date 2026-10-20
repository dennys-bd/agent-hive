// The protocol routes (#336): the Hive's blocks, the user's passages and what a workspace's runs receive. A passage write rewrites every live
// workspace's protocol files before it answers, so the next run reads it; the rewrite runs on the settings chain, where a save in flight has
// already set live, so the mcp.off it writes with is never older than the files a save just wrote.
import type { Express, Request, Response } from 'express';
import { workspaceByName } from './config.js';
import { withMemory } from './hooks-settings.js';
import type { Logger } from './log.js';
import { EMPTY_MEMORY, errorName, type MemoryStore, renderMemory } from './memory.js';
import type { PassageSave, PassageStore } from './passage-store.js';
import { BLOCKS, type ProtocolFor } from './protocol.js';
import { type Passage, passageAnchor, renderPassages } from './protocol-inserts.js';
import { UNKNOWN_WORKSPACE_MESSAGE, writeMemoryProtocols } from './server-memory.js';
import type { TemplateError } from './template.js';
import type { Config, OptionalTool } from './types.js';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
export const UNKNOWN_PASSAGE_MESSAGE = 'unknown passage';
export const TEXT_MESSAGE = 'text must be a string';
const DISK_MESSAGE = 'the passages cannot be read or written';

export interface ProtocolRouteDeps {
  requireLive(res: Response): { runtime: { config: Pick<Config, 'comb' | 'mcp'> } } | undefined;
  /** Runs `job` on the POST /settings chain: a save in flight has set live before the rewrite reads its mcp.off. */
  queueSave(job: () => Promise<void>): Promise<void>;
  passages: PassageStore;
  memory: Pick<MemoryStore, 'read' | 'writeProtocol'>;
  protocolFor: ProtocolFor;
  log: Pick<Logger, 'error'>;
}

interface ProtocolView {
  blocks: { id: string; stage: string; session: string; off: boolean; tool?: OptionalTool }[];
  passages: { id: string; after: string; text: string; orphan: boolean; errors: Record<string, TemplateError[]> }[];
}

const fail = (res: Response, status: number, error: string): void => void res.status(status).json({ error });

// A failure on disk is the server's, logged by its class only, as the memory routes do
async function guarded(deps: ProtocolRouteDeps, res: Response, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (err) {
    deps.log.error(`protocol: passages failed (${errorName(err)})`);
    fail(res, HTTP_SERVER_ERROR, DISK_MESSAGE);
  }
}

// The blocks as the screen strikes them through (#337), and each passage with the workspaces where its render fails
function protocolView(passages: readonly Passage[], config: Pick<Config, 'comb' | 'mcp'>): ProtocolView {
  const { off } = config.mcp;
  const renders = config.comb.workspaces.map(({ name }) => [name, renderPassages(passages, name)] as const);
  return {
    blocks: BLOCKS.map(({ id, stage, session, tool }) => ({ id, stage, session, off: tool !== undefined && off.includes(tool), ...(tool === undefined ? {} : { tool }) })),
    passages: passages.map(({ id, text }, index) => ({
      id, ...passageAnchor(text), text,
      errors: Object.fromEntries(renders.flatMap(([name, list]) => (list[index].errors.length > 0 ? [[name, list[index].errors]] : []))),
    })),
  };
}

function registerReads(app: Express, deps: ProtocolRouteDeps): void {
  app.get('/api/protocol', (_req, res) => guarded(deps, res, async () => {
    const live = deps.requireLive(res);
    if (!live) return;
    res.json(protocolView(await deps.passages.list(), live.runtime.config));
  }));
  app.get('/api/protocol/render', (req, res) => guarded(deps, res, async () => {
    const live = deps.requireLive(res);
    if (!live) return;
    const { config } = live.runtime;
    const workspace = workspaceByName(config, String(req.query.workspace ?? ''));
    if (!workspace) return fail(res, HTTP_NOT_FOUND, UNKNOWN_WORKSPACE_MESSAGE);
    const { off } = config.mcp;
    // an unreadable memory file is the bare protocol, as the writer writes it (#797)
    const [protocol, file] = await Promise.all([deps.protocolFor(workspace.name, off), deps.memory.read(workspace.name).catch(() => EMPTY_MEMORY)]);
    const memory = renderMemory(file.entries, off);
    res.json({ stage: withMemory(protocol.stage, memory), session: withMemory(protocol.session, memory), local: withMemory(protocol.local, memory) }); // #256: the protocol screen (#337) previews every kind
  }));
}

// After a write that happened: every live workspace's files, then the answer
function rewrite(deps: ProtocolRouteDeps, res: Response, ok: () => void): Promise<void> {
  return deps.queueSave(async () => {
    const live = deps.requireLive(res);
    if (!live) return;
    await writeMemoryProtocols(deps.memory, live.runtime.config, deps.log); // logs a workspace's failure, never throws
    ok();
  });
}

async function answered(deps: ProtocolRouteDeps, res: Response, result: PassageSave | undefined, ok: (id: string) => void): Promise<void> {
  if (result === undefined) return fail(res, HTTP_NOT_FOUND, UNKNOWN_PASSAGE_MESSAGE);
  if ('errors' in result) return void res.status(HTTP_BAD_REQUEST).json({ errors: result.errors });
  await rewrite(deps, res, () => ok(result.id));
}

const textOf = (req: Request): string | undefined => {
  const { text } = (req.body ?? {}) as { text?: unknown };
  return typeof text === 'string' ? text : undefined;
};

function registerWrites(app: Express, deps: ProtocolRouteDeps): void {
  app.post('/api/protocol/passages', (req, res) => guarded(deps, res, async () => {
    if (!deps.requireLive(res)) return;
    const text = textOf(req);
    if (text === undefined) return fail(res, HTTP_BAD_REQUEST, TEXT_MESSAGE);
    await answered(deps, res, await deps.passages.create(text), (id) => void res.status(HTTP_CREATED).json({ id }));
  }));
  app.put('/api/protocol/passages/:id', (req: Request<{ id: string }>, res) => guarded(deps, res, async () => {
    if (!deps.requireLive(res)) return;
    const text = textOf(req);
    if (text === undefined) return fail(res, HTTP_BAD_REQUEST, TEXT_MESSAGE);
    await answered(deps, res, await deps.passages.change(req.params.id, text), (id) => void res.json({ id }));
  }));
  app.delete('/api/protocol/passages/:id', (req: Request<{ id: string }>, res) => guarded(deps, res, async () => {
    if (!deps.requireLive(res)) return;
    if (!(await deps.passages.remove(req.params.id))) return fail(res, HTTP_NOT_FOUND, UNKNOWN_PASSAGE_MESSAGE);
    await rewrite(deps, res, () => void res.status(HTTP_NO_CONTENT).end());
  }));
}

export function registerProtocolRoutes(app: Express, deps: ProtocolRouteDeps): void {
  registerReads(app, deps);
  registerWrites(app, deps);
}
