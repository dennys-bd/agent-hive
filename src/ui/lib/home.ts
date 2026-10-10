// What the activities home lists (redesign 08): the sessions that need the user and the tasks last worked on. Derived from the State the
// dashboard already receives, like activities.ts; nothing of it is stored.
import { taskOfWorker } from '../../activities.js';
import { sessionsOf } from '../../tasks.js';
import type { Task, Worker, State } from '../../types.js';
import { t } from '../i18n.js';
import type { TaskState } from './status.js';
import { taskState } from './task-state.js';
import { DAY_MS, HOUR_MS } from './usage.js';

export type PendingStatus = 'waiting' | 'approval';
/** A session that needs the user: waiting on them, or on their approval. */
export interface PendingRow { task: Task; worker: Worker; status: PendingStatus }
/** A task the Hive last put to work: its task state (#663; 'empty' with none) and when. */
export interface RecentRow { task: Task; status: TaskState; lastUsedAt: string }

export const RECENT_LIMIT = 5;
const MINUTE_MS = 60_000;
const URGENCY: PendingStatus[] = ['waiting', 'approval']; // the order of mostUrgent's ranking

const isPending = (status: TaskState): status is PendingStatus => (URGENCY as TaskState[]).includes(status);

/** Every session waiting on the user, then every one awaiting approval; within one status the longest waiting first. */
export function pendingSessions(state: Pick<State, 'tasks' | 'workers' | 'activityRecords'>): PendingRow[] {
  const rows = state.workers.flatMap((worker): PendingRow[] => {
    const task = taskOfWorker(state, worker);
    return task !== undefined && isPending(worker.status) ? [{ task, worker, status: worker.status }] : [];
  });
  const since = (row: PendingRow): string => row.worker.waitingSince ?? row.worker.startedAt ?? '';
  return [...rows].sort((a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || since(a).localeCompare(since(b)));
}

/** The tasks whose Claude sessions the Hive used last, newest first, `limit` at most. A session saved before its dates were kept ('') never counts. */
export function recentActivities(state: Pick<State, 'tasks' | 'workers' | 'activities' | 'activityRecords'>, limit = RECENT_LIMIT): RecentRow[] {
  const rows = state.tasks.flatMap((task): RecentRow[] => {
    const last = sessionsOf(state, task.item.itemId).map((s) => s.lastUsedAt).filter((at) => at !== '').sort().at(-1);
    return last === undefined ? [] : [{ task, status: taskState(task, state), lastUsedAt: last }];
  });
  return [...rows].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).slice(0, limit);
}

const startOfDay = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

/** How long ago, short enough for the recent rows' 64px: now, minutes, hours today, yesterday, then days. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  const ago = now - at;
  if (ago < MINUTE_MS) return t('home.now');
  if (ago < HOUR_MS) return t('home.minutes', { n: Math.floor(ago / MINUTE_MS) });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return t('home.hours', { n: Math.floor(ago / HOUR_MS) });
  return days === 1 ? t('home.yesterday') : t('home.days', { n: days });
}
