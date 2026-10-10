// The view state's file in the home (#484), next to state.json: loaded once at boot, then rewritten whole on every change. Out of the
// reducer and out of hive.config.json: a drag is no rule and no setting.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomically } from './daemon-files.js';
import { VIEW_KEYS, type ViewKey, type ViewState } from './view-state.js';

export const VIEW_STATE_FILE = 'view-state.json';

export interface ViewStore {
  get(): ViewState;
  /** Replaces one key and resolves once the file holds it. A failed write rejects this call; the map is already updated, so the next set writes it. */
  set(key: ViewKey, value: unknown): Promise<void>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The file's JSON; undefined when it is missing, unreadable or not JSON
function parseFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The file's map, only the keys in VIEW_KEYS; {} when it is missing, unreadable, not JSON or not an object: a layout never fails a boot. */
export function readViewState(home: string): ViewState {
  const parsed = parseFile(join(home, VIEW_STATE_FILE));
  if (!isPlainObject(parsed)) return {};
  return Object.fromEntries(VIEW_KEYS.filter((key) => Object.hasOwn(parsed, key)).map((key) => [key, parsed[key]]));
}

/** The map in memory and its file. Writes queue on one chain, so two posts never interleave; each writes the map as it stands when it
 *  runs, a later set's key included, so no write drops one. writeAtomically is synchronous: the file is small. */
export function createViewStore(home: string, initial: ViewState): ViewStore {
  const path = join(home, VIEW_STATE_FILE);
  let map = initial;
  let chain: Promise<void> = Promise.resolve();
  const write = (): void => writeAtomically(path, `${JSON.stringify(map)}\n`);
  return {
    get: () => map,
    set(key, value) {
      map = { ...map, [key]: value };
      chain = chain.then(write, write); // a failed write never blocks the next one
      return chain;
    },
  };
}
