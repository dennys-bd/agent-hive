import { type DaemonAddress, recordedDaemon } from '../daemon.js';
import { SECRET_HEADER } from '../secret.js';
import { isJsonObject } from '../state-guards.js';
import { sseFrames } from '../tray-signal.js';
import { interventionsOf, RUN_ROUTE } from './metrics.js';
import type { Snapshot, WatchClient } from './watcher.js';

const UI_HEADER = 'x-hive-ui'; // mirrors server.ts's UI_HEADER, which pulls Express in
const REQUEST_TIMEOUT_MS = 10_000;

export interface DaemonClient extends WatchClient {
  payload(): Promise<Record<string, unknown>>;
  sleepRuns(ptyIds: readonly string[]): Promise<void>; // #472: one activity's live runs, as POST /ptys/sleep wants them
  continueActivity(activityId: string): Promise<void>; // #472: POST /activities/:id/continue, resuming a stage's session a sleep stopped
}
export interface ClientDeps { address?: (home: string) => DaemonAddress | undefined; fetch?: typeof fetch }

// A SyntaxError quotes a snippet of its input, and the frame is the whole State: the watcher logs this message, so it names nothing of it
function parsedFrame(frame: string): Record<string, unknown> {
  try {
    return JSON.parse(frame) as Record<string, unknown>;
  } catch {
    throw new Error('GET /events: the first frame does not parse');
  }
}

// The first /events frame is the whole State (server.ts writes it on connect); the stream is cancelled once read
async function firstFrame(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`GET /events: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('GET /events: the stream ended before a frame');
      const { frames, rest } = sseFrames(buffer + decoder.decode(value, { stream: true }));
      if (frames.length > 0) return parsedFrame(frames[0]);
      buffer = rest;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// #629: a task's work (slug, error, stopped, usage, result) lives on the activities and their records, so the snapshot carries all four lists
function snapshotOf(payload: Record<string, unknown>): Snapshot {
  const { tasks, workers, activities, activityRecords, slept } = payload as Partial<Snapshot>;
  if (!Array.isArray(tasks) || !Array.isArray(workers) || !Array.isArray(activities) || !Array.isArray(activityRecords)) throw new Error('GET /events: the daemon is not configured');
  return { tasks, workers, activities, activityRecords, ...(Array.isArray(slept) ? { slept } : {}) };
}

/** One home's daemon over HTTP, at that home's port and secret: the two daemons of a pair never mix. No message carries the secret. */
export function createDaemonClient(home: string, deps: ClientDeps = {}): DaemonClient {
  const fetchFn = deps.fetch ?? fetch;
  const target = (): DaemonAddress => {
    const address = (deps.address ?? recordedDaemon)(home);
    if (!address) throw new Error('the daemon of this home is not running');
    return address;
  };
  const payload = async (): Promise<Record<string, unknown>> => {
    const { port, secret } = target();
    return firstFrame(await fetchFn(`http://127.0.0.1:${port}/events`, { headers: { [SECRET_HEADER]: secret }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' }));
  };
  const read = async (path: string): Promise<unknown> => {
    const { port, secret } = target();
    const res = await fetchFn(`http://127.0.0.1:${port}${path}`, { headers: { [SECRET_HEADER]: secret }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GET ${path}: HTTP ${res.status}`);
    }
    return res.json();
  };
  // `shown` names the route in an error without the encoding; neither carries the secret
  const post = async (path: string, shown: string, body: Record<string, unknown>): Promise<void> => {
    const { port, secret } = target();
    const res = await fetchFn(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { [SECRET_HEADER]: secret, [UI_HEADER]: '1', 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`POST ${shown}: HTTP ${res.status}`);
  };
  return {
    payload,
    state: async () => snapshotOf(await payload()),
    setAuto: (itemId) => post(`/tasks/${encodeURIComponent(itemId)}/auto`, `/tasks/${itemId}/auto`, { auto: true }),
    setGreen: () => post('/signal', '/signal', { signal: 'green' }),
    // #472: a run daemon's own sleep all and Continue (server-runs.ts), with the run's secret: the run-mode recorder counts only the viewer's cookie
    sleepRuns: (ptyIds) => post('/ptys/sleep', '/ptys/sleep', { ptyIds: [...ptyIds] }),
    continueActivity: (activityId) => post(`/activities/${encodeURIComponent(activityId)}/continue`, `/activities/${activityId}/continue`, {}),
    // The secret's header: the main Hive's read is no intervention (#475)
    interventions: async () => {
      const body = await read(RUN_ROUTE);
      if (!isJsonObject(body) || !Array.isArray(body.interventions)) throw new Error(`GET ${RUN_ROUTE}: no interventions list`);
      return interventionsOf(body.interventions);
    },
  };
}
