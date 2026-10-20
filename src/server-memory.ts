import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Express, Request, Response } from 'express';
import { taskOfWorker } from './activities.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { EVENTS_FILE, type EventLog } from './events.js';
import type { Logger } from './log.js';
import {
  errorName, isMemoryRefusal, lessonRefusal, MEMORY_KIND_MESSAGE, MEMORY_TEXT_MESSAGE, memoryCounts, memoryView, type MemoryRefusal, type MemoryResult,
  type MemoryStore, withEdit, withEntry, withoutEntry,
} from './memory.js';
import { memoryRecord, memoryStats, type MemoryRecord } from './memory-stats.js';
import type { RunFields } from './server-events.js';
import type { Runtime } from './server.js';
import { type Config, isMemoryKind, MEMORY_CAP_MAX, MEMORY_CAP_MIN, type MemoryEntry, type MemoryFile, type MemoryKind, type MemoryRefusalCode, type SettingsBody, type Workspace } from './types.js';

// A workspace's memory on the server's side (#797): the protocol files on boot and on every Settings save, run.spawned's fields (Task 5) and
// the memory dialog's routes (Task 7). Nothing of a lesson's text reaches a log line or a record.

/** Each workspace's protocol files from its stored memory (#797), before any run reads them. A file the Hive cannot read costs that workspace
 * its memory (the store still writes the bare protocol), logged, never the boot or the save. `off` comes from the config being activated, which
 * is not live yet (#336). */
export async function writeMemoryProtocols(memory: Pick<MemoryStore, 'writeProtocol'>, config: Pick<Config, 'comb' | 'mcp'>, log: Pick<Logger, 'error'>): Promise<void> {
  await Promise.all(config.comb.workspaces.map(({ name }) =>
    memory.writeProtocol(name, config.mcp.off).catch((err: unknown) => log.error(`memory ${name}: unreadable (${errorName(err)})`))));
}

/** run.spawned's memory fields (#797): the run's task's workspace's last rendered memory, which is what its protocol file holds; none for a run
 * on no task (a local session), a workspace that does not resolve, or an empty memory. */
export function runMemory(memory: Pick<MemoryStore, 'rendered'>, config: () => Pick<Config, 'comb'> | undefined): RunFields {
  return (state, worker) => {
    const current = config();
    const task = taskOfWorker(state, worker);
    const workspace = current && task ? taskWorkspace(current, task) : undefined;
    const rendered = workspace ? memory.rendered(workspace.name) : undefined;
    return workspace && rendered && rendered.ids.length > 0 ? { memory_ids: rendered.ids, memory_chars: rendered.chars, workspace: workspace.name } : {};
  };
}

export const UNKNOWN_WORKSPACE_MESSAGE = 'unknown workspace';
export const UNREADABLE_MEMORY_MESSAGE = 'the memory cannot be read';
export const CAP_MESSAGE = `cap must be an integer from ${MEMORY_CAP_MIN} to ${MEMORY_CAP_MAX}`;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const STATUS: Record<MemoryRefusalCode, number> = { bad_memory: 400, memory_secret: 400, memory_full: 409, unknown_memory: 404 };

export interface MemoryRouteDeps {
  requireLive(res: Response): { runtime: Pick<Runtime, 'config'> } | undefined;
  memory: Pick<MemoryStore, 'read' | 'update'>;
  events: Pick<EventLog, 'write'>;
  log: Pick<Logger, 'error'>;
  home: string; // where events.jsonl is, for the stats
  /** Runs `save` on the POST /settings chain, after every save already queued: one writer of hive.config.json at a time (#115, as #404). */
  queueSave(save: () => Promise<void>): Promise<void>;
  saveSettings(body: Partial<SettingsBody>, res: Response): Promise<void>;
}

// The body's lesson, trimmed, or why it is refused: a kind of MEMORY_KINDS, then the tool's own checks
function lessonOf(body: unknown): { kind: MemoryKind; text: string } | MemoryRefusal {
  const { kind, text } = (typeof body === 'object' && body !== null ? body : {}) as { kind?: unknown; text?: unknown };
  if (!isMemoryKind(kind)) return { code: 'bad_memory', message: MEMORY_KIND_MESSAGE };
  if (typeof text !== 'string') return { code: 'bad_memory', message: MEMORY_TEXT_MESSAGE };
  return lessonRefusal(text) ?? { kind, text: text.trim() };
}

// The code rides with the message: the dialog shows it in the user's language, the tool's message being English only
const refused = (res: Response, refusal: MemoryRefusal): void => void res.status(STATUS[refusal.code]).json({ error: refusal.message, code: refusal.code });

const unreadable = (deps: MemoryRouteDeps, res: Response, workspace: string, err: unknown): void => {
  deps.log.error(`memory ${workspace}: unreadable (${errorName(err)})`);
  res.status(HTTP_SERVER_ERROR).json({ error: UNREADABLE_MEMORY_MESSAGE });
};

// The live workspace :name names, its memoryCap included (#73), or its 404 written (requireLive's 409 before any config)
function workspaceParam(deps: MemoryRouteDeps, req: Request, res: Response): Workspace | undefined {
  const current = deps.requireLive(res);
  if (!current) return undefined;
  const workspace = workspaceByName(current.runtime.config, String(req.params.name));
  if (workspace) return workspace;
  res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_WORKSPACE_MESSAGE });
  return undefined;
}

type Action = 'added' | 'edited' | 'removed';

// One write of the user's: the edit through the store, memory.changed with the lesson it touched (as it stood before a removal), the new view
async function write(deps: MemoryRouteDeps, res: Response, workspace: Workspace, action: Action, idOf: (file: MemoryFile) => string, edit: (file: MemoryFile) => MemoryResult): Promise<void> {
  let touched = undefined as MemoryEntry | undefined;
  try {
    const saved = await deps.memory.update(workspace.name, (file) => {
      const result = edit(file);
      const id = idOf(file);
      touched = (isMemoryRefusal(result) || action === 'removed' ? file : result).entries.find((e) => e.id === id);
      return result;
    });
    if (isMemoryRefusal(saved)) return refused(res, saved);
    if (touched) deps.events.write({ event: 'memory.changed', level: 'info', action, kind: touched.kind, by: 'user', id: touched.id, workspace: workspace.name, ...memoryCounts(saved) });
    res.json(memoryView(saved, workspace.memoryCap));
  } catch (err) {
    unreadable(deps, res, workspace.name, err);
  }
}

// The workspace's records of events.jsonl.1 then events.jsonl, each line parsed as it is read and dropped unless it is the workspace's; a file
// that is not there has none
async function eventRecords(home: string, workspace: string): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (const file of [`${EVENTS_FILE}.1`, EVENTS_FILE]) {
    const path = join(home, file);
    if (!(await access(path).then(() => true, () => false))) continue;
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY })) {
      const record = line.includes('"workspace"') ? memoryRecord(line, workspace) : undefined;
      if (record) records.push(record);
    }
  }
  return records;
}

// What the parser accepts as a workspace's memoryCap (#73), checked here so the dialog gets its own code instead of the parser's sentence
const isCap = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= MEMORY_CAP_MIN && (value as number) <= MEMORY_CAP_MAX;

// PUT …/memory/cap (#115): the dialog's total limit, through saveSettings on the POST /settings chain as POST /trusted-domains grows its
// list (#404), so it never races a Settings save. The workspaces are read on the chain, not at arrival: a save queued first may have changed
// or removed this one. The same cap answers ok with no write.
async function saveCap(deps: MemoryRouteDeps, req: Request, res: Response): Promise<void> {
  if (workspaceParam(deps, req, res) === undefined) return;
  const { cap } = (req.body ?? {}) as { cap?: unknown };
  if (!isCap(cap)) return void res.status(HTTP_BAD_REQUEST).json({ error: CAP_MESSAGE, code: 'cap_range' });
  await deps.queueSave(async () => {
    const workspace = workspaceParam(deps, req, res);
    const live = workspace && deps.requireLive(res);
    if (!workspace || !live) return;
    if (workspace.memoryCap === cap) return void res.json({ ok: true });
    const { comb } = live.runtime.config;
    const workspaces = comb.workspaces.map((w) => (w.name === workspace.name ? { ...w, memoryCap: cap } : w));
    await deps.saveSettings({ prefix: comb.prefix, workspaces }, res); // configFrom keeps every other saved key
  });
}

// GET /workspaces/:name/memory and …/stats: the view, and the last 7 days of the local event log
function registerReads(app: Express, deps: MemoryRouteDeps): void {
  app.get('/workspaces/:name/memory', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    try {
      res.json(memoryView(await deps.memory.read(workspace.name), workspace.memoryCap));
    } catch (err) {
      unreadable(deps, res, workspace.name, err);
    }
  });
  app.get('/workspaces/:name/memory/stats', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    try {
      const [file, records] = await Promise.all([deps.memory.read(workspace.name), eventRecords(deps.home, workspace.name)]);
      res.json(memoryStats(records, file.entries, Date.now()));
    } catch (err) {
      unreadable(deps, res, workspace.name, err);
    }
  });
}

// PUT …/cap, the total limit (#115); then POST, PUT and DELETE: a lesson of the user's, one rewritten, one removed
function registerWrites(app: Express, deps: MemoryRouteDeps): void {
  // before PUT …/:id: Express matches in order, and the lesson edit would take `cap` as a lesson id
  app.put('/workspaces/:name/memory/cap', (req: Request, res: Response) => saveCap(deps, req, res));
  app.post('/workspaces/:name/memory', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    const lesson = lessonOf(req.body);
    if ('code' in lesson) return refused(res, lesson);
    await write(deps, res, workspace, 'added', (file) => `m-${file.nextId}`, (file) => withEntry(file, lesson.kind, lesson.text, 'user', new Date().toISOString(), workspace.memoryCap));
  });
  app.put('/workspaces/:name/memory/:id', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    const lesson = lessonOf(req.body);
    if ('code' in lesson) return refused(res, lesson);
    const id = String(req.params.id);
    await write(deps, res, workspace, 'edited', () => id, (file) => withEdit(file, id, lesson.kind, lesson.text, new Date().toISOString(), workspace.memoryCap));
  });
  app.delete('/workspaces/:name/memory/:id', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    const id = String(req.params.id);
    await write(deps, res, workspace, 'removed', () => id, (file) => withoutEntry(file, id));
  });
}

/** A workspace's memory for the memory dialog (#797): saved at once, outside the Settings draft, since the workers write the same file at any
 * moment. Behind the same host, secret and UI-header gate as every dashboard write. The total limit (#115) is the exception that writes hive.config.json, through the settings chain. */
export function registerMemoryRoutes(app: Express, deps: MemoryRouteDeps): void {
  registerReads(app, deps);
  registerWrites(app, deps);
}
