// A benchmark run's own Hive (#475, api.benchmark.run-hive). A daemon booted on a run home (one holding benchmark.json) serves
// GET /benchmark-run and records the viewer's writes and first terminal input as interventions in <home>/interventions.json. Frozen, it
// refuses them and starts no run. hive.ts reads the marker before createServer.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import { createJsonStore } from '../json-store.js';
import { SECRET_HEADER } from '../secret.js';
import { HOOKS_PREFIX, WRITE_METHODS } from '../server-facts.js';
import { isJsonObject } from '../state-guards.js';
import { BENCH_TOKEN, EXPERIMENT_ID, type Intervention } from '../types.js';
import { INTERVENTIONS_FILE, interventionsOf, RUN_ROUTE } from './metrics.js';
import { MARKER_FILE, type RunMarker } from './run-home.js';

const isText = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : 'error');

// The marker rebuilt field by field, or its first problem
function markerOf(raw: unknown): RunMarker | string {
  if (!isJsonObject(raw)) return 'not an object';
  const { experiment, arm, round, pairs, token, frozen } = raw;
  if (!isJsonObject(experiment) || !isText(experiment.id) || !EXPERIMENT_ID.test(experiment.id) || !isText(experiment.name)) return '"experiment" must be { id, name }';
  if (!isJsonObject(arm) || !isText(arm.letter) || !isText(arm.name)) return '"arm" must be { letter, name }';
  if (!isCount(round) || !isCount(pairs)) return '"round" and "pairs" must be whole numbers';
  if (!isText(token) || !BENCH_TOKEN.test(token)) return '"token" is not a run token';
  if (typeof frozen !== 'boolean') return '"frozen" must be true or false';
  return { experiment: { id: experiment.id, name: experiment.name }, arm: { letter: arm.letter, name: arm.name }, round, pairs, token, frozen };
}

/** The run home's marker; undefined when there is none (a normal Hive). A file that cannot be read or is malformed throws naming the file: a
 *  run home is the main Hive's own, so a broken marker is a bug, not a mode. */
export async function readMarker(home: string): Promise<RunMarker | undefined> {
  let text: string;
  try {
    text = await readFile(join(home, MARKER_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${MARKER_FILE}: unreadable (${errorCode(err)})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${MARKER_FILE}: does not parse`);
  }
  const marker = markerOf(raw);
  if (typeof marker === 'string') throw new Error(`${MARKER_FILE}: ${marker}`);
  return marker;
}

/** The open route's frozen flip: a temp file and a rename, so a daemon never boots on half a marker. 0600, as prepareRun wrote it. */
export async function writeMarker(home: string, marker: RunMarker): Promise<void> {
  const path = join(home, MARKER_FILE);
  await writeFile(`${path}.tmp`, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export const TERMINAL_INPUT = 'terminal input';
const STORE_KEY = 'interventions'; // one file per home: the key only names the store's queue

export interface InterventionRecorder {
  record(action: string, detail: string): Promise<void>;
  recordInput(ptyId: string, detail: string): Promise<void>; // once per pty
  list(): Promise<Intervention[]>;
}

/** <home>/interventions.json, written whole (temp file and rename, 0600) one write at a time: the main Hive reads it, and a crash mid-write
 *  must not leave half an array. A file that is not a list is never overwritten. A failed write is logged by its code, never with what the
 *  user did, and never rejects: the request or the keystroke that caused it has already been answered. */
export function createRecorder(home: string, now: () => Date, log: (line: string) => void): InterventionRecorder {
  const store = createJsonStore<Intervention[]>({
    pathOf: () => join(home, INTERVENTIONS_FILE), empty: [], isLive: () => true, private: true,
    parse: (raw) => {
      if (!Array.isArray(raw)) throw new Error('not a list');
      return interventionsOf(raw);
    },
  });
  const typed = new Set<string>(); // the ptys whose input this daemon already recorded: one row per session, not per keystroke
  const append = (action: string, detail: string): Promise<void> => {
    const added: Intervention = { at: now().toISOString(), action, detail, by: 'user' };
    return store.update(STORE_KEY, (list) => [...list, added]).then(
      () => undefined,
      (err: unknown) => log(`benchmark run: ${INTERVENTIONS_FILE} not written (${errorCode(err)})`),
    );
  };
  return {
    record: append,
    recordInput: (ptyId, detail) => {
      if (typed.has(ptyId)) return Promise.resolve();
      typed.add(ptyId);
      return append(TERMINAL_INPUT, detail);
    },
    list: () => store.update(STORE_KEY, (list) => list), // queued behind the writes in flight; the same list writes nothing
  };
}

const HTTP_CONFLICT = 409;
const HTTP_ERROR = 400; // a refused request changed nothing
const VIEW_STATE_PREFIX = '/view-state/';

export interface RunMode { marker: RunMarker; recorder: InterventionRecorder }

// What the user did in the run's window. The viewer's page authenticates with its HttpOnly cookie and cannot send x-hive-secret, which a
// worker, the CLI, the menu bar and the main Hive always send. The view state is the window's layout and the hooks are the workers', so
// neither is the user's act
const isViewerWrite = (req: Request): boolean =>
  WRITE_METHODS.includes(req.method) && req.header(SECRET_HEADER) === undefined && !req.path.startsWith(HOOKS_PREFIX) && !req.path.startsWith(VIEW_STATE_PREFIX);

/** Mounted right after server.ts's secret gate, before the body parser: GET /benchmark-run (2.9's shell and the main Hive's watcher), and
 *  each viewer write refused when frozen (the run branch must not change after its evaluation) or recorded once it answered below 400. */
export function registerRunMode(app: Express, mode: RunMode): void {
  app.get(RUN_ROUTE, async (_req: Request, res: Response) => {
    res.json({ marker: mode.marker, interventions: await mode.recorder.list() });
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isViewerWrite(req)) return next();
    if (mode.marker.frozen) return void res.status(HTTP_CONFLICT).json({ error: 'frozen' });
    const detail = req.path; // the concrete path without the query; never the body, which can carry the user's own text
    res.on('finish', () => {
      if (res.statusCode >= HTTP_ERROR) return;
      // The matched route's pattern, read on finish as httpRecords reads it; a write that matched no route never answers below 400
      const route: unknown = req.route?.path;
      void mode.recorder.record(`${req.method} ${typeof route === 'string' ? route : detail}`, detail);
    });
    next();
  });
}
