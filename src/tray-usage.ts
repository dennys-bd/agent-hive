// The menu bar's plan lines (#197): one per plan window of the latest /events reading, with a small bar in the header's meter bands (#86).
// Electron is imported for its types only, so node:test covers all of it; main.ts turns the bitmaps into images and wires the menu.
import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import { AGENTS } from './agents.js';
import { AGENT_IDS, type AgentId, type PlanReadings, type RateLimits, type RateLimitWindow } from './types.js';
import { t } from './ui/i18n.js';
import { clock, countdown, type MeterBand, meterBand, PERCENT_MAX, shownWindow, windowLabel } from './ui/lib/usage.js';

export const METER_WIDTH = 22; // the bar at 1x; the 2x representation doubles both
export const METER_HEIGHT = 8;
const TRACK_HEIGHT = 4;
const BYTES_PER_PIXEL = 4; // B, G, R, A, premultiplied: Skia's N32 on macOS, what createFromBitmap reads
const OPAQUE = 255;
const TRACK_ALPHA = Math.round(0.35 * OPAQUE);
const BAND_RGB: Record<MeterBand, readonly number[]> = { neutral: [0x8e, 0x8e, 0x93], yellow: [0xe0, 0xb5, 0x2a], red: [0xd9, 0x53, 0x4f] };
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

// the main window's words are lower-case mid-sentence; a menu line starts upper-case (#242)
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A plan window's name on its menu line: the flow header's windowLabel (#242), upper-cased first: Session / Sessão, Week opus, or the
 *  key with spaces. */
export const windowName = (key: string): string => capitalized(windowLabel(key));

/** `Session 82% · resets in 2h40m`: the countdown is the header's, from `now`, in the header's words, lower-case after the dot (#242). Past
 * its reset a window reads as the footer shows it (#557, shownWindow): `Week 0% · resets in 3d`, `Session 0% · 5h`, or the name and 0% alone. */
export function usageLine(key: string, limit: RateLimitWindow, now: number): string {
  const { percent, resetsAt, length } = shownWindow(key, limit, now);
  const reset = resetsAt === undefined ? length : t('limits.resets', { time: countdown(resetsAt, now) });
  return reset === undefined ? `${windowName(key)} ${percent}%` : `${windowName(key)} ${percent}% · ${reset}`;
}

/** The line's bar: a rounded track filled from the left over `percent` in the band's color, the rest in translucent grey. */
export function meterBitmap(percent: number, band: MeterBand, scale: 1 | 2): Buffer {
  const width = METER_WIDTH * scale;
  const height = METER_HEIGHT * scale;
  const radius = (TRACK_HEIGHT * scale) / 2;
  const filled = Math.round((width * clamp(percent, 0, PERCENT_MAX)) / PERCENT_MAX);
  const bitmap = Buffer.alloc(width * height * BYTES_PER_PIXEL); // transparent
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // the pixel's center against the track: within `radius` of its midline, which stops `radius` short of each end
      const dx = x + 0.5 - clamp(x + 0.5, radius, width - radius);
      const dy = y + 0.5 - height / 2;
      if (dx * dx + dy * dy > radius * radius) continue;
      const isFill = x < filled;
      const alpha = isFill ? OPAQUE : TRACK_ALPHA;
      const bgr = [...BAND_RGB[isFill ? band : 'neutral']].reverse().map((c) => Math.round((c * alpha) / OPAQUE));
      bitmap.set([...bgr, alpha], (y * width + x) * BYTES_PER_PIXEL);
    }
  }
  return bitmap;
}

type MeterIcon = (percent: number, band: MeterBand) => NativeImage | undefined;

// One agent's lines (#929), its label first: `Claude · Session 82% · resets in 2h40m`, each read at its own reading's time
function agentLines(agent: AgentId, reading: RateLimits | undefined, now: number, locale: string, icon: MeterIcon, onClick: () => void): MenuItemConstructorOptions[] {
  // a window that is not an object (null from a bad frame) would throw here and keep the whole menu from opening: it is skipped
  const windows = Object.entries(reading?.windows ?? {}).filter(([, limit]) => typeof limit === 'object' && limit !== null);
  if (!reading || windows.length === 0) return [];
  const toolTip = capitalized(t('limits.at', { time: clock(reading.at, locale) })); // a reading can be old: it comes from a worker's status line
  return windows.map(([key, limit]): MenuItemConstructorOptions => {
    const percent = shownWindow(key, limit, now).percent; // the line's number, so the bar's band matches it, a past window's 0 too (#557)
    return { label: `${AGENTS[agent].label} · ${usageLine(key, limit, now)}`, icon: icon(percent, meterBand(percent)), toolTip, click: onClick };
  });
}

/** The menu's plan section: every agent's lines in AGENT_IDS order (#929), each window in its reading's order, then a separator; none before a
 *  reading. `icon` builds the bar's image (main.ts owns nativeImage) and may give none; a click opens the main window, where the details are. */
export function usageItems(readings: PlanReadings | undefined, now: number, locale: string, icon: MeterIcon, onClick: () => void): MenuItemConstructorOptions[] {
  const lines = AGENT_IDS.flatMap((agent) => agentLines(agent, readings?.[agent], now, locale, icon, onClick));
  return lines.length === 0 ? [] : [...lines, { type: 'separator' }];
}
