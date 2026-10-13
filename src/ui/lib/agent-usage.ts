// The footer's usage group, its pure part (#223): no DOM, no React, so node:test imports it from dist/src/ui/lib.
import type { AgentId, PlanReadings, RateLimits } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import { countdown, DAY_MS, HOUR_MS } from './usage.js';

const MINUTE_MS = 60_000;
// The windows the footer shows, keyed as the agent reports them, in this order (#669, #929): the short label on the chip and in its tooltip,
// the long one in the panel
const LIMITS: ReadonlyArray<{ key: string; short: MessageKey; long: MessageKey }> = [
  { key: 'five_hour', short: 'usage.window.fiveHour', long: 'window.session' },
  { key: 'seven_day', short: 'usage.window.week', long: 'window.week' },
  { key: 'thirty_day', short: 'usage.window.thirtyDay', long: 'window.thirtyDay' }, // #929: Codex's free plan has only this one
];

/** One window the footer shows, its percent rounded. */
export interface UsageWindow { key: string; short: string; long: string; percent: number; resetsAt: string }

export const usageWindows = (reading: RateLimits): UsageWindow[] =>
  LIMITS.flatMap(({ key, short, long }) => {
    const window = reading.windows[key];
    return window === undefined ? [] : [{ key, short: t(short), long: t(long), percent: Math.round(window.usedPercent), resetsAt: window.resetsAt }];
  });

/** The readings the footer can show (#223): one whose windows are all unknown keys reads as no reading, so every form says so alike. */
export const shownReadings = (readings: PlanReadings): PlanReadings =>
  Object.fromEntries(Object.entries(readings).filter(([, reading]) => reading !== undefined && usageWindows(reading).length > 0));

/** The minimal form's number: the highest rounded percent of the shown windows; undefined with nothing to measure. */
export function highestPercent(reading: RateLimits | undefined): number | undefined {
  const percents = reading === undefined ? [] : usageWindows(reading).map((w) => w.percent);
  return percents.length === 0 ? undefined : Math.max(...percents);
}

/** The agent the group form names: the highest percent in any window, the first on a tie. One without a reading never wins unless none has
 * one, and then it is the first agent. */
export function topAgent(agents: readonly AgentId[], readings: PlanReadings): AgentId | undefined {
  let top: { agent: AgentId; percent: number } | undefined;
  for (const agent of agents) {
    const percent = highestPercent(readings[agent]);
    if (percent !== undefined && (top === undefined || percent > top.percent)) top = { agent, percent };
  }
  return top?.agent ?? agents[0];
}

/** A reading's age, `há 2 min`. The home's relativeTime says `ontem`, which reads wrong for a reading. A future or unparseable `at` is now. */
export function readAgo(at: string, now: number): string {
  const age = Math.max(0, now - Date.parse(at)) || 0; // NaN: an unparseable at
  if (age < MINUTE_MS) return t('usage.ago.now');
  if (age < HOUR_MS) return t('usage.ago.minutes', { n: Math.floor(age / MINUTE_MS) });
  if (age < DAY_MS) return t('usage.ago.hours', { n: Math.floor(age / HOUR_MS) });
  return t('usage.ago.days', { n: Math.floor(age / DAY_MS) });
}

/** The chip's tooltip (handoff §3.1): `claude · 5h 5% · reinicia 1h39m · … · lido há 2 min`, or `codex · sem leitura`. */
export function chipTitle(agent: AgentId, reading: RateLimits | undefined, now: number): string {
  if (reading === undefined) return `${agent} · ${t('usage.noReading')}`;
  const windows = usageWindows(reading).map((w) => `${w.short} ${w.percent}% · ${t('usage.resets', { time: countdown(w.resetsAt, now) })}`);
  return [agent, ...windows, t('usage.read', { ago: readAgo(reading.at, now) })].join(' · ');
}

/** The ↻'s title: `atualizar claude · lido há 2 min`, or `· sem leitura` before the first reading. */
export const refreshTitle = (agent: AgentId, reading: RateLimits | undefined, now: number): string =>
  reading === undefined ? t('usage.refreshNone', { agent }) : t('usage.refreshOne', { agent, ago: readAgo(reading.at, now) });
