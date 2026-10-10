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
import { type Config, isMemoryKind, type MemoryEntry, type MemoryFile, type MemoryKind, type MemoryRefusalCode } from './types.js';

// A workspace's memory on the server's side (#797): the protocol files on boot and on every Settings save, run.spawned's fields (Task 5) and
// the memory dialog's routes (Task 7). Nothing of a lesson's text reaches a log line or a record.

/** Each workspace's protocol files from its stored memory (#797), before any run reads them. A file the Hive cannot read costs that workspace
 * its memory (the store still writes the bare protocol), logged, never the boot or the save. */
export async function writeMemoryProtocols(memory: Pick<MemoryStore, 'writeProtocol'>, config: Pick<Config, 'comb'>, log: Pick<Logger, 'error'>): Promise<void> {
  await Promise.all(config.comb.workspaces.map(({ name }) =>
    memory.writeProtocol(name).catch((err: unknown) => log.error(`memory ${name}: unreadable (${errorName(err)})`))));
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
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const STATUS: Record<MemoryRefusalCode, number> = { bad_memory: 400, memory_secret: 400, memory_full: 409, unknown_memory: 404 };

export interface MemoryRouteDeps {
  requireLive(res: Response): { runtime: Pick<Runtime, 'config'> } | undefined;
  memory: Pick<MemoryStore, 'read' | 'update'>;
  events: Pick<EventLog, 'write'>;
  log: Pick<Logger, 'error'>;
  home: string; // where events.jsonl is, for the stats
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

// The live workspace :name names, or its 404 written (requireLive's 409 before any config)
function workspaceParam(deps: MemoryRouteDeps, req: Request, res: Response): string | undefined {
  const current = deps.requireLive(res);
  if (!current) return undefined;
  const name = String(req.params.name);
  if (workspaceByName(current.runtime.config, name)) return name;
  res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_WORKSPACE_MESSAGE });
  return undefined;
}

type Action = 'added' | 'edited' | 'removed';

// One write of the user's: the edit through the store, memory.changed with the lesson it touched (as it stood before a removal), the new view
async function write(deps: MemoryRouteDeps, res: Response, workspace: string, action: Action, idOf: (file: MemoryFile) => string, edit: (file: MemoryFile) => MemoryResult): Promise<void> {
  let touched = undefined as MemoryEntry | undefined;
  try {
    const saved = await deps.memory.update(workspace, (file) => {
      const result = edit(file);
      const id = idOf(file);
      touched = (isMemoryRefusal(result) || action === 'removed' ? file : result).entries.find((e) => e.id === id);
      return result;
    });
    if (isMemoryRefusal(saved)) return refused(res, saved);
    if (touched) deps.events.write({ event: 'memory.changed', level: 'info', action, kind: touched.kind, by: 'user', id: touched.id, workspace, ...memoryCounts(saved) });
    res.json(memoryView(saved));
  } catch (err) {
    unreadable(deps, res, workspace, err);
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

// GET /workspaces/:name/memory and …/stats: the view, and the last 7 days of the local event log
function registerReads(app: Express, deps: MemoryRouteDeps): void {
  app.get('/workspaces/:name/memory', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    try {
      res.json(memoryView(await deps.memory.read(workspace)));
    } catch (err) {
      unreadable(deps, res, workspace, err);
    }
  });
  app.get('/workspaces/:name/memory/stats', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    try {
      const [file, records] = await Promise.all([deps.memory.read(workspace), eventRecords(deps.home, workspace)]);
      res.json(memoryStats(records, file.entries, Date.now()));
    } catch (err) {
      unreadable(deps, res, workspace, err);
    }
  });
}

// POST, PUT and DELETE: a lesson of the user's, one rewritten, one removed
function registerWrites(app: Express, deps: MemoryRouteDeps): void {
  app.post('/workspaces/:name/memory', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    const lesson = lessonOf(req.body);
    if ('code' in lesson) return refused(res, lesson);
    await write(deps, res, workspace, 'added', (file) => `m-${file.nextId}`, (file) => withEntry(file, lesson.kind, lesson.text, 'user', new Date().toISOString()));
  });
  app.put('/workspaces/:name/memory/:id', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    const lesson = lessonOf(req.body);
    if ('code' in lesson) return refused(res, lesson);
    const id = String(req.params.id);
    await write(deps, res, workspace, 'edited', () => id, (file) => withEdit(file, id, lesson.kind, lesson.text, new Date().toISOString()));
  });
  app.delete('/workspaces/:name/memory/:id', async (req: Request, res: Response) => {
    const workspace = workspaceParam(deps, req, res);
    if (workspace === undefined) return;
    const id = String(req.params.id);
    await write(deps, res, workspace, 'removed', () => id, (file) => withoutEntry(file, id));
  });
}

/** A workspace's memory for the memory dialog (#797): saved at once, outside the Settings draft, since the workers write the same file at any
 * moment. Behind the same host, secret and UI-header gate as every dashboard write. */
export function registerMemoryRoutes(app: Express, deps: MemoryRouteDeps): void {
  registerReads(app, deps);
  registerWrites(app, deps);
}
