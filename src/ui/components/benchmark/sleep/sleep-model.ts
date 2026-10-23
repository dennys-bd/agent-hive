// The sleep and wake dialogs' pure parts (#468): what sleeps, what it leaves in progress, the open sleep, whether the deadline passed while
// asleep, the slept span and the bodies the routes take. No React, so the suite tests them alone.
import { HH_MM, untilDeadline } from '../../../../benchmark/deadline.js';
import type { BenchRun, BenchSleep, Experiment } from '../../../../types.js';

/** /wake's deadline (server-benchmark-control.ts, WAKE), declared here: runner-sleep.ts's would pull the daemon client into the UI's types. */
export type WakeDeadline = 'finish-round' | 'none' | { until: string };
export type WakeChoice = 'finish-round' | 'until' | 'none';
export interface SleepBody { reason: string; wakeAt?: string }
export interface WakeBody { deadline?: WakeDeadline } // absent keeps the deadline

export const MAX_REASON = 500; // the route's MAX_REASON
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;

export const controlPath = (id: string, action: 'sleep' | 'wake'): string => `/benchmark/experiments/${encodeURIComponent(id)}/${action}`;

/** The runs dormir sleeps: every round's running and waiting ones, as the reducer's `slept` moves them (a rerun of an earlier round too). */
export const runsToSleep = (e: Experiment): BenchRun[] =>
  e.rounds.flatMap((r) => r.runs).filter((r) => r.status === 'running' || r.status === 'waiting');

/** The runs a wake continues: every sleeping one, as the reducer's `woken` reads them. */
export const sleepingRuns = (e: Experiment): BenchRun[] => e.rounds.flatMap((r) => r.runs).filter((r) => r.status === 'sleeping');

// A task with a stage has started; the delivered ones are done, so what is left is in progress
const inProgress = (r: BenchRun): number => Math.max(0, (r.metrics?.tasks.filter((task) => task.stages.length > 0).length ?? 0) - r.delivered);
export const tasksInProgress = (runs: readonly BenchRun[]): number => runs.reduce((sum, r) => sum + inProgress(r), 0);

export const openSleep = (e: Experiment): BenchSleep | undefined => [...e.sleeps].reverse().find((s) => s.wokeAt === undefined);

/** The scheduler's rule: the deadline is the next `until` after the sleep began, so one earlier in the day than the sleep is the next day's. */
export function isDeadlinePassed(e: Experiment, now: Date): boolean {
  const sleep = openSleep(e);
  const until = e.pace.until;
  return sleep !== undefined && until !== undefined && untilDeadline(new Date(sleep.at), until) <= now;
}

/** Every sleep's span, the open one up to now. */
export const sleptMs = (e: Experiment, now: Date): number =>
  e.sleeps.reduce((sum, s) => sum + Math.max(0, (s.wokeAt === undefined ? now.getTime() : Date.parse(s.wokeAt)) - Date.parse(s.at)), 0);

/** `2h05` / `45m`: report-md.ts's duration, which the UI cannot import (that file writes to disk). */
export function spanText(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  const hours = Math.floor(minutes / HOUR_MINUTES);
  return hours === 0 ? `${minutes}m` : `${hours}h${String(minutes % HOUR_MINUTES).padStart(2, '0')}`;
}

export const isTime = (value: string): boolean => HH_MM.test(value);

export const sleepBody = (reason: string, wakeAt?: string): SleepBody =>
  (wakeAt === undefined ? { reason: reason.trim() } : { reason: reason.trim(), wakeAt });

export function wakeBody(isPassed: boolean, choice: WakeChoice, until: string): WakeBody {
  if (!isPassed) return {};
  return choice === 'until' ? { deadline: { until } } : { deadline: choice };
}
