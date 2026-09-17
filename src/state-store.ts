import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, SIGNALS, STATUSES } from './orchestrator.js';
import { isBoardQuota } from './polling.js';
import { isRateLimits } from './rate-limits.js';
import type { Signal, Slot, SlotEvent, SlotEventKind, State, Status, UsageRule, UsageSample } from './types.js';

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

// Files written before the status keys were neutral carry the Portuguese words and a lastEvent sentence.
const LEGACY_STATUS: Record<string, Status> = { vazio: 'empty', trabalhando: 'working', esperando_voce: 'waiting', aguardando_review: 'review' };
const EVENT_KINDS: readonly SlotEventKind[] = ['starting', 'prompt', 'tool', 'waiting', 'pr', 'paused', 'turn'];

const isSlotEvent = (value: unknown): value is SlotEvent =>
  typeof value === 'object' && value !== null && EVENT_KINDS.includes((value as SlotEvent).kind)
  && ((value as SlotEvent).detail === undefined || typeof (value as SlotEvent).detail === 'string');

function statusOf(raw: unknown): Status | undefined {
  if (STATUSES.includes(raw as Status)) return raw as Status;
  return typeof raw === 'string' && Object.hasOwn(LEGACY_STATUS, raw) ? LEGACY_STATUS[raw] : undefined; // hasOwn: "constructor" is not a status
}

// Unknown status: nothing to trust beyond the id (boot gives every occupied slot as dead anyway). A sentence or a bad object is not a lastEvent.
function normalizeSlot(slot: Slot): Slot {
  const status = statusOf(slot.status);
  if (status === undefined) return { id: slot.id, status: 'empty' };
  const { lastEvent, ...rest } = slot;
  return { ...rest, status, ...(isSlotEvent(lastEvent) ? { lastEvent } : {}) };
}

// Files written before the signal or the budget existed lack these fields; anything unknown reads as the default.
function normalize(parsed: State): State {
  const { rateLimits, boardQuota, ...rest } = parsed;
  return {
    ...rest,
    slots: parsed.slots.map(normalizeSlot),
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
