import { type DaemonAddress, recordedDaemon } from '../../src/daemon.js';
import { SECRET_HEADER } from '../../src/secret.js';
import { sseFrames } from '../../src/tray-signal.js';
import type { Snapshot, WatchClient } from './watcher.js';

const UI_HEADER = 'x-hive-ui'; // mirrors server.ts's UI_HEADER, which pulls Express in
const REQUEST_TIMEOUT_MS = 10_000;

export interface DaemonClient extends WatchClient { payload(): Promise<Record<string, unknown>> }
export interface ClientDeps { address?: (home: string) => DaemonAddress | undefined; fetch?: typeof fetch }

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
      if (frames.length > 0) return JSON.parse(frames[0]) as Record<string, unknown>;
      buffer = rest;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// #629: a task's work (slug, error, stopped, usage, result) lives on the activities and their records, so the snapshot carries all four lists
function snapshotOf(payload: Record<string, unknown>): Snapshot {
  const { tasks, workers, activities, activityRecords } = payload as Partial<Snapshot>;
  if (!Array.isArray(tasks) || !Array.isArray(workers) || !Array.isArray(activities) || !Array.isArray(activityRecords)) throw new Error('GET /events: the daemon is not configured');
  return { tasks, workers, activities, activityRecords };
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
  };
}
