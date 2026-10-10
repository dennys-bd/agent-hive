import { canSchedule } from './orchestrator.js';
import type { SourceQuota, SourceSync, State } from './types.js';

export const POLL_INTERVAL_MS = 30_000;
export const IDLE_POLL_INTERVAL_MS = 5 * 60_000;
export const QUOTA_RESERVE = 500; // ponytail: fixed 10 % of the 5 000/h GraphQL quota, config it if a source ever needs another

// Below the reserve and before the reset: what is left goes to the workers' own gh calls (gh pr create…). The native view's read obeys it too (#756).
export function inBackoff(status: SourceSync | undefined, now: number): boolean {
  const quota = status?.quota;
  return quota !== undefined && quota.remaining < QUOTA_RESERVE && Date.parse(quota.resetsAt) > now;
}

// A missing or unparsable stamp reads as stale: NaN fails the `<`.
const isStale = (status: SourceSync | undefined, now: number): boolean => !(now - Date.parse(status?.polledAt ?? '') < IDLE_POLL_INTERVAL_MS);

/** Whether a timer tick should poll `source` (#180: each source on its own quota and poll time): never inside its quota backoff; otherwise
 * when a job could start or its last read is stale. */
export function shouldPoll(state: State, source: string, now: number): boolean {
  const status = Object.hasOwn(state.syncs, source) ? state.syncs[source] : undefined;
  return !inBackoff(status, now) && (canSchedule(state, now) || isStale(status, now));
}

const isCount = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0;

/** A quota reading in the shape the Hive writes: a reopened Hive keeps backing off only on a reading it can trust. */
export function isSourceQuota(value: unknown): value is SourceQuota {
  if (typeof value !== 'object' || value === null) return false;
  const { limit, remaining, resetsAt, at } = value as SourceQuota;
  return isCount(limit) && isCount(remaining) && typeof resetsAt === 'string' && typeof at === 'string';
}

/** One source's saved status for state-store (#180): each field kept only in the shape the Hive writes, anything else dropped. */
export function syncOf(value: unknown): SourceSync {
  if (typeof value !== 'object' || value === null) return {};
  const { polledAt, quota, error } = value as SourceSync;
  return { ...(typeof polledAt === 'string' ? { polledAt } : {}), ...(isSourceQuota(quota) ? { quota } : {}), ...(typeof error === 'string' ? { error } : {}) };
}
