// Codex's plan limits (#929): the rate_limits each token_count of a rollout carries (finding §9). The newest rollout that has one speaks for
// the account: it also sees the user's own Codex use outside the Hive.
import { lstat } from 'node:fs/promises';
import { collectWindows, isPercent, isRecord, PERCENT_MAX } from '../rate-limits.js';
import type { RateLimits, RateLimitWindow } from '../types.js';
import type { PlanLimitsDeps } from './claude-limits.js';
import { dateFolders, parseRolloutLine, rolloutsIn, sessionsRoot } from './codex-transcript.js';
import { eachLine } from './jsonl.js';

const MS_PER_SECOND = 1000;
// ponytail: only the durations seen or assumed: the free plan's 30 days (finding §9), a paid plan's 5 h and week (unverified). Any other is
// dropped; add its key here once a plan shows one
const WINDOW_KEYS: ReadonlyMap<number, string> = new Map([[300, 'five_hour'], [10_080, 'seven_day'], [43_200, 'thirty_day']]);
// ponytail: the newest 5 rollouts, each read whole every 5 minutes; past them a reading is stale anyway. Tail-read if rollouts ever weigh
const PLAN_FILES_MAX = 5;

// `used_percent` from 0 (clamped to 100) and `resets_at` as positive integer epoch seconds still ahead: an old rollout never reports a full
// window that has reset since
function parseWindow(raw: unknown, now: Date): RateLimitWindow | undefined {
  if (!isRecord(raw) || !isPercent(raw.used_percent)) return undefined;
  const { resets_at: resetsAt } = raw;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt) || resetsAt <= 0) return undefined;
  const reset = new Date(resetsAt * MS_PER_SECOND);
  if (Number.isNaN(reset.getTime()) || reset.getTime() <= now.getTime()) return undefined;
  return { usedPercent: Math.min(raw.used_percent, PERCENT_MAX), resetsAt: reset.toISOString() };
}

/** A token_count's `rate_limits` → the persisted shape: primary and secondary, each keyed by its window_minutes. */
export function parseCodexRateLimits(raw: unknown, now: Date): RateLimits | undefined {
  if (!isRecord(raw)) return undefined;
  const keyed = [raw.primary, raw.secondary].flatMap((window): [string, unknown][] => {
    const key = isRecord(window) && typeof window.window_minutes === 'number' ? WINDOW_KEYS.get(window.window_minutes) : undefined;
    return key === undefined ? [] : [[key, window]];
  });
  return collectWindows(Object.fromEntries(keyed), (window) => parseWindow(window, now), now);
}

// A rollout's last token_count that carries rate_limits; only a line naming the key is parsed
async function lastRateLimits(path: string): Promise<unknown> {
  let last: unknown;
  await eachLine(path, (text) => {
    if (!text.includes('"rate_limits"')) return;
    const line = parseRolloutLine(text);
    if (line?.type === 'event_msg' && line.payload.type === 'token_count' && isRecord(line.payload.rate_limits)) last = line.payload.rate_limits;
  });
  return last;
}

// The file Codex wrote last speaks first
async function newestFirst(files: string[]): Promise<string[]> {
  const times = await Promise.all(files.map((file) => lstat(file).then((s) => s.mtimeMs, () => -1)));
  return files.map((file, i) => ({ file, at: times[i] })).sort((a, b) => b.at - a.at).map(({ file }) => file);
}

// Up to `max` rollouts: the newest date folder first and, inside one, the newest file first
async function newestRollouts(root: string, max: number): Promise<string[]> {
  let picked: string[] = [];
  for (const folder of [...(await dateFolders(root))].reverse()) {
    if (picked.length >= max) break;
    picked = [...picked, ...(await newestFirst(await rolloutsIn(folder)))];
  }
  return picked.slice(0, max);
}

/** The newest rollout's plan reading (#929): its last rate_limits; a newer rollout without any hands over to the next. No rollout, or none
 * among the newest PLAN_FILES_MAX with one: undefined. A rollout that fails to read is skipped. */
export async function readCodexPlanLimits(deps: Pick<PlanLimitsDeps, 'env' | 'now'> = {}): Promise<RateLimits | undefined> {
  const now = deps.now?.() ?? new Date();
  for (const file of await newestRollouts(sessionsRoot(deps.env), PLAN_FILES_MAX)) {
    const raw = await lastRateLimits(file).catch(() => undefined);
    if (raw !== undefined) return parseCodexRateLimits(raw, now);
  }
  return undefined;
}
