import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, SIGNALS } from './orchestrator.js';
import { isBoardQuota } from './polling.js';
import { isRateLimits } from './rate-limits.js';
import type { Signal, State, UsageRule, UsageSample } from './types.js';

const STATE_FILE = 'state.json';

const isSignal = (value: unknown): value is Signal => SIGNALS.includes(value as Signal);
const isSample = (value: unknown): value is UsageSample =>
  typeof value === 'object' && value !== null
  && typeof (value as UsageSample).at === 'string' && Number.isFinite((value as UsageSample).tokens);

// Config validates the rules; here only the shape is checked, so a hand-edited state.json cannot feed the reducer garbage.
const isRule = (value: unknown): value is UsageRule => {
  if (typeof value !== 'object' || value === null) return false;
  const { percent, maxWorkers, signal } = value as UsageRule;
  return Number.isFinite(percent) && (maxWorkers === undefined || Number.isFinite(maxWorkers))
    && (signal === undefined || isSignal(signal)) && (maxWorkers !== undefined || signal !== undefined);
};

// Files written before the signal or the budget existed lack these fields; anything unknown reads as the default.
function normalize(parsed: State): State {
  const { rateLimits, boardQuota, ...rest } = parsed;
  return {
    ...rest,
    signal: isSignal(parsed.signal) ? parsed.signal : 'green',
    usage: Array.isArray(parsed.usage) ? parsed.usage.filter(isSample) : [],
    budget: parsed.budget ?? {},
    usageRules: Array.isArray(parsed.usageRules) ? parsed.usageRules.filter(isRule) : [],
    ...(isRateLimits(rateLimits) ? { rateLimits } : {}), // wrong shape or legacy file: no key at all, the header shows nothing
    ...(isBoardQuota(boardQuota) ? { boardQuota } : {}), // kept so a Hive reopened mid-backoff keeps backing off until the reset
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
