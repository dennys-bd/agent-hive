import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, SIGNALS } from './orchestrator.js';
import type { Signal, State, UsageSample } from './types.js';

const STATE_FILE = 'state.json';

const isSignal = (value: unknown): value is Signal => SIGNALS.includes(value as Signal);
const isSample = (value: unknown): value is UsageSample =>
  typeof value === 'object' && value !== null
  && typeof (value as UsageSample).at === 'string' && Number.isFinite((value as UsageSample).tokens);

// Files written before the signal or the budget existed lack these fields; anything unknown reads as the default.
function normalize(parsed: State): State {
  return {
    ...parsed,
    signal: isSignal(parsed.signal) ? parsed.signal : 'green',
    usage: Array.isArray(parsed.usage) ? parsed.usage.filter(isSample) : [],
    budget: parsed.budget ?? {},
    usageRules: Array.isArray(parsed.usageRules) ? parsed.usageRules : [],
  };
}

export async function loadState(hiveDir: string, maxConcurrent: number): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(join(hiveDir, STATE_FILE), 'utf8')) as State;
    if (Array.isArray(parsed.slots) && Array.isArray(parsed.queue) && Number.isInteger(parsed.maxConcurrent)) {
      return normalize(parsed);
    }
  } catch {
    // missing or corrupt: start fresh
  }
  return initialState(maxConcurrent);
}

export async function saveState(hiveDir: string, state: State): Promise<void> {
  const path = join(hiveDir, STATE_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}
