// The dashboard's view state (#484): its layout and habits, kept in the Hive's home behind GET /view-state and POST /view-state/:key, so a
// new port, and with it a new origin, keeps them. main.tsx loads the snapshot before the first render, so every read stays synchronous.
// A write updates the snapshot at once and posts the key's whole value after VIEW_WRITE_DELAY_MS of quiet: a drag writes on every move.
import type { ViewKey, ViewState } from '../../view-state.js';
import { getJson, postJson } from './api.js';

export const VIEW_WRITE_DELAY_MS = 250;

let snapshot: ViewState = {};
const timers = new Map<ViewKey, ReturnType<typeof setTimeout>>();

// The key's whole value as the snapshot holds it now. Nothing is retried: the next change of the key posts all of it again.
function post(key: ViewKey, keepalive: boolean): void {
  postJson(`/view-state/${key}`, { value: snapshot[key] }, { keepalive })
    .catch((err: unknown) => console.error(`view state: ${key} not saved`, err));
}

/** GET /view-state into the snapshot; {} on any error, which every consumer reads as its defaults. Never rejects. */
export async function loadViewState(): Promise<ViewState> {
  try {
    const loaded = await getJson<unknown>('/view-state');
    // Anything but a plain object would make every readView throw on the first render
    snapshot = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded) ? loaded : {};
  } catch (err) {
    console.error('view state: not loaded', err);
    snapshot = {};
  }
  return snapshot;
}

/** The key's value in the snapshot, as stored: each consumer parses its own. */
export const readView = (key: ViewKey): unknown => snapshot[key];

/** A new snapshot with the key's value, then the key's debounce restarted. */
export function writeView(key: ViewKey, value: unknown): void {
  snapshot = { ...snapshot, [key]: value };
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    post(key, false);
  }, VIEW_WRITE_DELAY_MS));
}

// Best effort: browsers cap keepalive bodies at about 64 KiB in total, so a larger pending value is lost only when the window closes
// within the delay of its last change. postJson keeps x-hive-ui and content-type, which a sendBeacon could not set.
function flush(): void {
  for (const [key, timer] of timers) {
    clearTimeout(timer);
    post(key, true);
  }
  timers.clear();
}

/** Tests only: drops every pending post and sets the snapshot to `seed`. */
export function resetViewState(seed: ViewState = {}): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  snapshot = seed;
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
