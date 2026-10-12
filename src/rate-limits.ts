import type { Language, RateLimits, RateLimitWindow } from './types.js';

export const MAX_WINDOWS = 8;
/** How often the plan limits are read again (#924: the Hive's timer, moved here from plan-limits.ts; the reading is the runner's). */
export const PLAN_LIMITS_INTERVAL_MS = 5 * 60_000;
// Claude Code names windows like five_hour / seven_day; the key becomes a State key and a UI label, so it is kept to this.
const WINDOW_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const PERCENT_MAX = 100;
const SAME_RESET_TOLERANCE_MS = 60_000; // the usage endpoint's resets_at jitters by ~1s per call; a real rollover moves it by hours
const WEEKLY_PREFIX = 'seven_day_';
const LABELS: Record<Language, Record<string, string>> = {
  pt: { five_hour: 'sessão', seven_day: 'semana' },
  en: { five_hour: 'session', seven_day: 'week' },
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export type WindowParser = (raw: unknown) => RateLimitWindow | undefined;

/** Shared by every reading's parser (#924: the runner's): key filter, cap at MAX_WINDOWS, nothing when no window survives (then nothing is
 * dispatched). */
export function collectWindows(source: Record<string, unknown>, parse: WindowParser, now: Date): RateLimits | undefined {
  const entries = Object.entries(source)
    .filter(([key]) => WINDOW_KEY.test(key))
    .flatMap<[string, RateLimitWindow]>(([key, raw]) => {
      const window = parse(raw);
      return window ? [[key, window]] : [];
    })
    .slice(0, MAX_WINDOWS); // any local process can post here, and the endpoint is undocumented: the State never grows past this
  return entries.length === 0 ? undefined : { at: now.toISOString(), windows: Object.fromEntries(entries) };
}

const isWindow = ([key, value]: [string, unknown]): boolean =>
  WINDOW_KEY.test(key) && isRecord(value) && isPercent(value.usedPercent) && value.usedPercent <= PERCENT_MAX
  && typeof value.resetsAt === 'string';

/** The persisted shape, for state-store: same bounds as parseRateLimits, so a hand-edited state.json never feeds the UI garbage. */
export function isRateLimits(value: unknown): value is RateLimits {
  return isRecord(value) && typeof value.at === 'string' && isRecord(value.windows) && Object.entries(value.windows).every(isWindow);
}

/** Per window, the reading that counts: a later reset wins outright (the window rolled over), an earlier one is stale and dropped,
 * and inside the same window the higher percent wins, because use only grows until the reset. */
function freshest(previous: RateLimitWindow | undefined, next: RateLimitWindow): RateLimitWindow {
  if (!previous) return next;
  const before = Date.parse(previous.resetsAt);
  const after = Date.parse(next.resetsAt);
  if (Math.abs(after - before) > SAME_RESET_TOLERANCE_MS) return after > before ? next : previous;
  return next.usedPercent >= previous.usedPercent ? next : previous;
}

/** Every reading is a snapshot, and a worker's status line replays the one its own Claude Code cached, which can be hours old: taken
 * whole it would drag the meter back to what that session last saw. Merged window by window a stale snapshot changes nothing, and a
 * window the reading does not carry is kept as it stands. `at` is always the latest reading: it is when the Hive last heard anything. */
export function mergeRateLimits(previous: RateLimits | undefined, next: RateLimits): RateLimits {
  if (!previous) return next;
  const merged = Object.entries(next.windows).map(([key, window]) => [key, freshest(previous.windows[key], window)] as const);
  return { at: next.at, windows: { ...previous.windows, ...Object.fromEntries(merged) } };
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
