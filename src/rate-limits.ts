import type { RateLimits, RateLimitWindow } from './types.js';

export const MAX_WINDOWS = 8;
// Claude Code names windows like five_hour / seven_day; the key becomes a State key and a UI label, so it is kept to this.
const WINDOW_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MS_PER_SECOND = 1000;
const WEEKLY_PREFIX = 'seven_day_';
const LABELS: Record<string, string> = { five_hour: 'sessão', seven_day: 'semana' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// `used_percentage` is a finite number from 0; `resets_at` is a positive integer in epoch seconds. Anything else drops the window.
function parseWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { used_percentage: usedPercent, resets_at: resetsAt } = raw;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt) || resetsAt <= 0) return undefined;
  const reset = new Date(resetsAt * MS_PER_SECOND);
  return Number.isNaN(reset.getTime()) ? undefined : { usedPercent, resetsAt: reset.toISOString() }; // past the Date range: invalid
}

/** `body.rate_limits` of a status line JSON → the persisted shape, or nothing when no window survives (then nothing is dispatched). */
export function parseRateLimits(body: unknown, now: Date): RateLimits | undefined {
  if (!isRecord(body) || !isRecord(body.rate_limits)) return undefined;
  const entries = Object.entries(body.rate_limits)
    .filter(([key]) => WINDOW_KEY.test(key))
    .flatMap<[string, RateLimitWindow]>(([key, raw]) => {
      const window = parseWindow(raw);
      return window ? [[key, window]] : [];
    })
    .slice(0, MAX_WINDOWS); // any local process can post here: the State never grows past this
  return entries.length === 0 ? undefined : { at: now.toISOString(), windows: Object.fromEntries(entries) };
}

const isWindow = (value: unknown): value is RateLimitWindow =>
  isRecord(value) && Number.isFinite(value.usedPercent) && typeof value.resetsAt === 'string';

/** The persisted shape, for state-store: a hand-edited state.json never feeds the UI garbage. */
export function isRateLimits(value: unknown): value is RateLimits {
  return isRecord(value) && typeof value.at === 'string' && isRecord(value.windows) && Object.values(value.windows).every(isWindow);
}

/** five_hour → sessão, seven_day → semana, seven_day_<x> → semana <x>; anything else reads as its key with spaces. */
export function windowLabel(key: string): string {
  if (Object.hasOwn(LABELS, key)) return LABELS[key]; // hasOwn: "constructor" must not resolve to Object's
  if (key.startsWith(WEEKLY_PREFIX)) return `semana ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

/** The line the worker's status line shows: "sessão 23% · semana 41%". */
export function formatRateLimits(limits: RateLimits): string {
  return Object.entries(limits.windows)
    .map(([key, window]) => `${windowLabel(key)} ${Math.round(window.usedPercent)}%`)
    .join(' · ');
}
