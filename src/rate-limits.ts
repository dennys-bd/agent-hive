import type { Language, RateLimits, RateLimitWindow } from './types.js';

export const MAX_WINDOWS = 8;
// Claude Code names windows like five_hour / seven_day; the key becomes a State key and a UI label, so it is kept to this.
const WINDOW_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MS_PER_SECOND = 1000;
const PERCENT_MAX = 100;
const WEEKLY_PREFIX = 'seven_day_';
const LABELS: Record<Language, Record<string, string>> = {
  pt: { five_hour: 'sessão', seven_day: 'semana' },
  en: { five_hour: 'session', seven_day: 'week' },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// `used_percentage` is a finite number from 0 (clamped to 100: the meter never overflows); `resets_at` is a positive integer in
// epoch seconds. Anything else drops the window.
function parseWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { used_percentage: usedPercent, resets_at: resetsAt } = raw;
  if (!isPercent(usedPercent)) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt) || resetsAt <= 0) return undefined;
  const reset = new Date(resetsAt * MS_PER_SECOND);
  if (Number.isNaN(reset.getTime())) return undefined; // past the Date range: invalid
  return { usedPercent: Math.min(usedPercent, PERCENT_MAX), resetsAt: reset.toISOString() };
}

type WindowParser = (raw: unknown) => RateLimitWindow | undefined;

// Shared by both sources: key filter, cap at MAX_WINDOWS, nothing when no window survives (then nothing is dispatched).
function collectWindows(source: Record<string, unknown>, parse: WindowParser, now: Date): RateLimits | undefined {
  const entries = Object.entries(source)
    .filter(([key]) => WINDOW_KEY.test(key))
    .flatMap<[string, RateLimitWindow]>(([key, raw]) => {
      const window = parse(raw);
      return window ? [[key, window]] : [];
    })
    .slice(0, MAX_WINDOWS); // any local process can post here, and the endpoint is undocumented: the State never grows past this
  return entries.length === 0 ? undefined : { at: now.toISOString(), windows: Object.fromEntries(entries) };
}

/** `body.rate_limits` of a status line JSON → the persisted shape. */
export function parseRateLimits(body: unknown, now: Date): RateLimits | undefined {
  if (!isRecord(body) || !isRecord(body.rate_limits)) return undefined;
  return collectWindows(body.rate_limits, parseWindow, now);
}

// The usage endpoint window: `utilization` percent and `resets_at` as a date string. `null` (a window the plan lacks) drops it.
function parseUsageWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { utilization, resets_at: resetsAt } = raw;
  if (!isPercent(utilization) || typeof resetsAt !== 'string') return undefined;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return undefined;
  return { usedPercent: Math.min(utilization, PERCENT_MAX), resetsAt: reset.toISOString() };
}

/** The body of GET /api/oauth/usage (undocumented: parsed defensively) → the same persisted shape. `extra_usage` falls to the filter. */
export function parseUsage(body: unknown, now: Date): RateLimits | undefined {
  return isRecord(body) ? collectWindows(body, parseUsageWindow, now) : undefined;
}

const isWindow = ([key, value]: [string, unknown]): boolean =>
  WINDOW_KEY.test(key) && isRecord(value) && isPercent(value.usedPercent) && value.usedPercent <= PERCENT_MAX
  && typeof value.resetsAt === 'string';

/** The persisted shape, for state-store: same bounds as parseRateLimits, so a hand-edited state.json never feeds the UI garbage. */
export function isRateLimits(value: unknown): value is RateLimits {
  return isRecord(value) && typeof value.at === 'string' && isRecord(value.windows) && Object.entries(value.windows).every(isWindow);
}

/** five_hour → sessão / session, seven_day → semana / week, seven_day_<x> → semana <x> / week <x>; anything else reads as its key with spaces. */
export function windowLabel(key: string, language: Language): string {
  const labels = LABELS[language];
  if (Object.hasOwn(labels, key)) return labels[key]; // hasOwn: "constructor" must not resolve to Object's
  if (key.startsWith(WEEKLY_PREFIX)) return `${labels.seven_day} ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

/** The line the worker's status line shows: "sessão 23% · semana 41%" or "session 23% · week 41%". */
export function formatRateLimits(limits: RateLimits, language: Language): string {
  return Object.entries(limits.windows)
    .map(([key, window]) => `${windowLabel(key, language)} ${Math.round(window.usedPercent)}%`)
    .join(' · ');
}
