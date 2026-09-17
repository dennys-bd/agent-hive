import { canSchedule } from './orchestrator.js';
import type { BoardQuota, State } from './types.js';

export const POLL_INTERVAL_MS = 30_000;
export const IDLE_POLL_INTERVAL_MS = 5 * 60_000;
export const QUOTA_RESERVE = 500; // ponytail: fixed 10 % of the 5 000/h GraphQL quota, config it if a board ever needs another

// Below the reserve and before the reset: what is left goes to the workers' own gh calls (gh pr create…).
function inBackoff(state: State, now: number): boolean {
  const quota = state.boardQuota;
  return quota !== undefined && quota.remaining < QUOTA_RESERVE && Date.parse(quota.resetsAt) > now;
}

// A missing or unparsable stamp reads as stale: NaN fails the `<`.
const isStale = (state: State, now: number): boolean => !(now - Date.parse(state.lastPolledAt ?? '') < IDLE_POLL_INTERVAL_MS);

/** Whether a timer tick should hit the board: never inside a quota backoff; otherwise when a job could start or the last read is stale. */
export function shouldPoll(state: State, now: number): boolean {
  return !inBackoff(state, now) && (canSchedule(state, now) || isStale(state, now));
}

const isCount = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0;

/** The persisted shape, for state-store: a reopened Hive keeps backing off only on a reading it can trust. */
export function isBoardQuota(value: unknown): value is BoardQuota {
  if (typeof value !== 'object' || value === null) return false;
  const { limit, remaining, resetsAt, at } = value as BoardQuota;
  return isCount(limit) && isCount(remaining) && typeof resetsAt === 'string' && typeof at === 'string';
}
