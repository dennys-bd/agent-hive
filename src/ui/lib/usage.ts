// Pure meter math for the header and the cards. No DOM, no React: node:test imports it from dist/src/ui/lib.
import type { Slot } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';

// Mirrors src/usage.ts, which cannot be imported here (it pulls node:fs into the browser).
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
export const PERCENT_MAX = 100;
// Mirrors src/polling.ts (pulls the orchestrator into the browser).
export const QUOTA_RESERVE = 500;
// Mirrors src/rate-limits.ts; the text comes from the dictionary.
const WINDOW_LABEL: Record<string, MessageKey> = { five_hour: 'window.session', seven_day: 'window.week' };
const WEEKLY_PREFIX = 'seven_day_';

export function usageTotals(usage: { at: string; tokens: number }[], now: number): { hour: number; day: number } {
  return usage.reduce((totals, { at, tokens }) => {
    const age = now - Date.parse(at);
    return { hour: totals.hour + (age < HOUR_MS ? tokens : 0), day: totals.day + (age < DAY_MS ? tokens : 0) };
  }, { hour: 0, day: 0 });
}

export const withinLimit = (total: number, limit?: number): boolean => limit === undefined || limit <= 0 || total < limit;
export const percent = (used: number, limit: number): number => Math.round((used / limit) * PERCENT_MAX);

// 842, 12.3k, 1.2M: fits the header and the card meta
export function fmt(n: number): string {
  if (n < THOUSAND) return String(n);
  if (n < MILLION) return `${(n / THOUSAND).toFixed(1)}k`;
  return `${(n / MILLION).toFixed(1)}M`;
}

export function elapsed(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const minutes = Math.floor((now - new Date(iso).getTime()) / MINUTE_MS);
  return minutes < MINUTES_PER_HOUR ? `${minutes} min` : `${Math.floor(minutes / MINUTES_PER_HOUR)} h ${minutes % MINUTES_PER_HOUR} min`;
}

export function windowLabel(key: string): string {
  if (Object.hasOwn(WINDOW_LABEL, key)) return t(WINDOW_LABEL[key]);
  if (key.startsWith(WEEKLY_PREFIX)) return `${t('window.week')} ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

// Mirrors isFree in src/orchestrator.ts, which pulls node:crypto into the browser.
export const isFree = (slot: Slot): boolean => slot.status === 'empty' && !slot.draining;
