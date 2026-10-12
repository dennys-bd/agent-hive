// Pure meter math for the header and the tasks. No DOM, no React: node:test imports it from dist/src/ui/lib.
import { isPlanSource, type PlanSource, type SourceQuota, type SourceSync, type DisableUntil, type RuleSource, type State, type UsageRule } from '../../types.js';
import { type MessageKey, statusText, t } from '../i18n.js';

// Mirrors src/usage.ts, which cannot be imported here (it pulls node:fs into the browser).
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
export const PERCENT_MAX = 100;
export const YELLOW_AT = 70;
export const RED_AT = 90;
// Mirrors src/polling.ts (pulls the orchestrator into the browser).
export const QUOTA_RESERVE = 500;
// Mirrors src/rate-limits.ts; the text comes from the dictionary.
const WINDOW_LABEL: Record<string, MessageKey> = { five_hour: 'window.session', seven_day: 'window.week', thirty_day: 'window.thirtyDay' };
const WEEKLY_PREFIX = 'seven_day_';
// The strip and the header name a rule by its source and floor; the source names are the meter labels.
const SOURCE_LABEL: Record<RuleSource, MessageKey> = { hour: 'usage.hour', day: 'usage.day', session: 'window.session', week: 'window.week', month: 'window.thirtyDay' };

export function usageTotals(usage: { at: string; tokens: number }[], now: number): { hour: number; day: number } {
  return usage.reduce((totals, { at, tokens }) => {
    const age = now - Date.parse(at);
    return { hour: totals.hour + (age < HOUR_MS ? tokens : 0), day: totals.day + (age < DAY_MS ? tokens : 0) };
  }, { hour: 0, day: 0 });
}

export const withinLimit = (total: number, limit?: number): boolean => limit === undefined || limit <= 0 || total < limit;
export const percent = (used: number, limit: number): number => Math.round((used / limit) * PERCENT_MAX);

export type MeterBand = 'neutral' | 'yellow' | 'red';
export const meterBand = (percentValue: number): MeterBand =>
  percentValue >= RED_AT ? 'red' : percentValue >= YELLOW_AT ? 'yellow' : 'neutral';

// 842, 12.3k, 1.2M: fits the header and the task meta
export function fmt(n: number): string {
  if (n < THOUSAND) return String(n);
  if (n < MILLION) return `${(n / THOUSAND).toFixed(1)}k`;
  return `${(n / MILLION).toFixed(1)}M`;
}

// HH:MM in the given locale; shared by the header and the rules section for reset times.
export const clock = (iso: string, locale: string): string => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

// Whole minutes, "X min" below an hour and "X h Y min" above: a worker's run and a task's total (#248).
export function duration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes < MINUTES_PER_HOUR ? `${minutes} min` : `${Math.floor(minutes / MINUTES_PER_HOUR)} h ${minutes % MINUTES_PER_HOUR} min`;
}

export function elapsed(iso: string | undefined, now = Date.now()): string {
  return iso ? duration(now - new Date(iso).getTime()) : '';
}

// The two largest non-zero units among days/hours/minutes: 1d12h, 2h40m, 45m, 3h, 2d; clamped to 0m once the reset has passed.
export const countdown = (iso: string, now: number): string => compact(new Date(iso).getTime() - now);

// The same two units for any span (redesign 06): the detail's total and a session's age read 1h31m, as the countdowns do.
export function compact(remaining: number): string {
  if (!Number.isFinite(remaining) || remaining <= 0) return '0m';
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** A task in backoff (#805): its status word and the time until the Hive types continue; the word alone with no wait to read. */
export const backoffLabel = (until: string | undefined, now: number): string =>
  until === undefined ? statusText('backoff') : `${statusText('backoff')} · ${compact(Date.parse(until) - now)}`;

export function windowLabel(key: string): string {
  if (Object.hasOwn(WINDOW_LABEL, key)) return t(WINDOW_LABEL[key]);
  if (key.startsWith(WEEKLY_PREFIX)) return `${t('window.week')} ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

/** `session ≥ 80%, week ≥ 70%`: the rules behind a lock or a strip segment, in the order they fired.
 * `joiner` lets the strip join rules inside one clause with ` and ` / ` e `, keeping the default comma for the locked hints. */
export const describeRules = (rules: UsageRule[], joiner = ', '): string =>
  rules.map((r) => `${t(SOURCE_LABEL[r.source])} ≥ ${r.percent}%`).join(joiner);

// Mirrors inBackoff in src/polling.ts
export const inBackoff = (quota: SourceQuota | undefined, now: number): boolean =>
  quota !== undefined && quota.remaining < QUOTA_RESERVE && Date.parse(quota.resetsAt) > now;

/** The pausar regra popover's fixed horizons (#297, redesign 02), in the menu's order; personalizado… posts its own time. */
export type PauseChoice = 'reset' | 'quarter' | 'hour' | 'fourHours' | 'tomorrow';
const PAUSE_MINUTES: Record<'quarter' | 'hour' | 'fourHours', number> = { quarter: 15, hour: 60, fourHours: 240 };
const MORNING_HOUR = 7; // até amanhã ends at the next 07:00, local time

/** The next 07:00 after `now`, local time: até amanhã's end, and the time the popover shows beside it. */
export function nextMorning(now: number): Date {
  const morning = new Date(now);
  morning.setHours(MORNING_HOUR, 0, 0, 0);
  if (morning.getTime() <= now) morning.setDate(morning.getDate() + 1);
  return morning;
}

/** What a pause item posts. The UI computes `at`: it and the server run on one machine, so their clocks agree. */
export function pauseUntil(choice: PauseChoice, now: number): DisableUntil {
  if (choice === 'reset') return { kind: 'reset' };
  if (choice === 'tomorrow') return { kind: 'at', at: nextMorning(now).toISOString() };
  return { kind: 'at', at: new Date(now + PAUSE_MINUTES[choice] * MINUTE_MS).toISOString() };
}

/** How long until `iso`: "52 min" or "3 h 5 min" under a day, "4d10h" beyond, like the reset countdowns. */
export function timeLeft(iso: string, now: number): string {
  const ms = Math.max(0, Date.parse(iso) - now);
  return ms < DAY_MS ? duration(ms) : countdown(iso, now);
}

// Mirrors PLAN_WINDOW in src/usage-rules.ts.
const PLAN_WINDOW: Record<PlanSource, string> = { session: 'five_hour', week: 'seven_day', month: 'thirty_day' };

/** When a plan source's window resets, for até resetar; undefined for a rolling budget source or before the first reading. */
export const windowResetsAt = (state: Pick<State, 'rateLimits'>, source: RuleSource): string | undefined =>
  (isPlanSource(source) ? state.rateLimits?.windows[PLAN_WINDOW[source]]?.resetsAt : undefined);

/** What the ruler marks as now (#512), mirroring sourcePercents in src/usage-rules.ts (src/usage.ts pulls node:fs into the browser).
 * Undefined when there is nothing to measure: no plan reading yet, or a budget source with no limit. A window past its reset reads 0. */
export function sourcePercent(state: Pick<State, 'usage' | 'budget' | 'rateLimits'>, source: RuleSource, now: number): number | undefined {
  if (isPlanSource(source)) {
    const reading = state.rateLimits?.windows[PLAN_WINDOW[source]];
    if (reading === undefined) return undefined;
    return Date.parse(reading.resetsAt) <= now ? 0 : Math.round(reading.usedPercent);
  }
  const limit = source === 'hour' ? state.budget.maxTokensPerHour : state.budget.maxTokensPerDay;
  return limit ? percent(usageTotals(state.usage, now)[source], limit) : undefined;
}

/** The freshest GitHub quota among the syncs (#512): every GitHub source polls with the Hive's one account, so one reading speaks for all. */
export const latestQuota = (syncs: Record<string, SourceSync>): SourceQuota | undefined =>
  Object.values(syncs).reduce<SourceQuota | undefined>((latest, b) => (b.quota && (!latest || b.quota.at > latest.at) ? b.quota : latest), undefined);
