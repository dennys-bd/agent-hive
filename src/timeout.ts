// A timeout as the user writes it (#511): 30s, 10m, 1h. One grammar for a workspace's setup step and a run command, in the config
// parser, the settings form and the timers. Not tasks.ts's DURATION: `after` counts days and never seconds.
export const TIMEOUT = /^([1-9]\d*)([smh])$/;
/** A day: past any step or command worth bounding, and far under setTimeout's ~24.8-day ceiling, where Node would fire at once. */
export const TIMEOUT_MAX_MS = 24 * 3_600_000;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Milliseconds of a timeout text, trimmed; undefined for anything else, over TIMEOUT_MAX_MS included. Never throws. */
export function timeoutMs(text: string): number | undefined {
  const match = TIMEOUT.exec(text.trim());
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms <= TIMEOUT_MAX_MS ? ms : undefined;
}
