// A benchmark run's own Hive as the dashboard sees it (#469, api.benchmark.run-hive): GET /benchmark-run, read once before the first render
// as the view state is, so the write gate is in place before any control can write. A 404 (the route exists only in run mode, 3.5) or an
// answer that is not a run is a normal Hive: nothing is installed and nothing changes.
import { useSyncExternalStore } from 'react';
import type { RunMarker } from '../../../../benchmark/run-home.js';
import type { Intervention } from '../../../../types';
import { t } from '@/i18n';
import { getJson, setWriteGate, WriteCancelled, type WriteGate } from '@/lib/api';
import { readView, writeView } from '@/lib/view-state';

export interface RunHive { marker: RunMarker; interventions: Intervention[]; home: string }
/** A write waiting on the popover (#469): the control that asked (undefined: the popover centres) and its answer. */
export interface PendingAsk { anchor: HTMLElement | undefined; answer(isApproved: boolean, isNoAsk: boolean): void }
export const RUN_ROUTE = '/benchmark-run';
/** The watcher's own poll, since terminal input grows the count server-side. */
export const RUN_POLL_MS = 15_000;
const NO_ASK_KEY = 'runNoAsk';
const HTTP_NOT_FOUND = 404;

let run: RunHive | undefined;
let pending: PendingAsk | undefined;
const listeners = new Set<() => void>();
const notify = (): void => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';

// The route's answer, checked: the page trusts nothing it reads, and a test's catch-all {"ok":true} must read as a normal Hive
function isRunHive(value: unknown): value is RunHive {
  if (!isObject(value) || !isObject(value.marker) || !Array.isArray(value.interventions) || !isText(value.home)) return false;
  const { experiment, arm, round, pairs, token, frozen } = value.marker;
  return isObject(experiment) && isText(experiment.name) && isObject(arm) && isText(arm.letter) && isText(arm.name)
    && typeof round === 'number' && typeof pairs === 'number' && isText(token) && typeof frozen === 'boolean';
}

async function read(): Promise<RunHive | undefined> {
  try {
    const answer = await getJson<unknown>(RUN_ROUTE);
    return isRunHive(answer) ? answer : undefined;
  } catch (err) {
    if ((err as { status?: unknown }).status !== HTTP_NOT_FOUND) console.error('benchmark run: not read', err); // a 404 is a normal Hive
    return undefined;
  }
}

/** The count again (#469): after a write the gate let through, and every RUN_POLL_MS. A failed read keeps what the band shows. */
export async function refreshRunHive(): Promise<void> {
  const next = await read();
  if (run === undefined || next === undefined) return;
  run = next;
  notify();
}

const cancelled = (): WriteCancelled => new WriteCancelled(t('benchmark.run.cancelled'));

// What the gate asks before a write (spec decisions 3, 4, 7): frozen refuses with human copy (3.5 answers 409 anyway); a don't-ask-again lets
// it go; else the popover, anchored at the control that was clicked. One ask at a time: a write made while one is open waits on that same
// answer, so a click that fires two writes is never half applied
let asking: Promise<void> | undefined;
function ask(): Promise<void> {
  if (run === undefined) return Promise.resolve();
  if (run.marker.frozen) return Promise.reject(new Error(t('benchmark.run.frozen')));
  if (readView(NO_ASK_KEY) === true) return Promise.resolve();
  if (asking !== undefined) return asking;
  const active = document.activeElement;
  asking = new Promise<void>((resolve, reject) => {
    const own: PendingAsk = {
      anchor: active instanceof HTMLElement && active !== document.body ? active : undefined,
      answer: (isApproved, isNoAsk) => {
        if (pending !== own) return; // a late second answer (Escape after a click) must not settle a newer ask
        pending = undefined;
        asking = undefined;
        notify();
        if (!isApproved) return reject(cancelled());
        if (isNoAsk) writeView(NO_ASK_KEY, true); // the run daemon's view state: a reload keeps it, and it is never an intervention
        resolve();
      },
    };
    pending = own;
    notify();
  });
  return asking;
}

/** RunModeHost's unmount: an ask nobody can answer any more is a cancel, or every later write would wait on it. */
export const cancelPendingAsk = (): void => pending?.answer(false, false);

const GATE: WriteGate = { ask, written: () => void refreshRunHive() };

/** main.tsx, before the first render (#469): run mode installs the gate; a normal Hive leaves everything as it was. Never rejects. */
export async function bootRunHive(): Promise<void> {
  run = await read();
  if (run !== undefined) setWriteGate(GATE);
  notify();
}

export const readRunHive = (): RunHive | undefined => run;
export const readPendingAsk = (): PendingAsk | undefined => pending;
export const useRunHive = (): RunHive | undefined => useSyncExternalStore(subscribe, readRunHive);
export const usePendingAsk = (): PendingAsk | undefined => useSyncExternalStore(subscribe, readPendingAsk);

/** Tests only: no run, no pending ask, no gate. */
export function resetRunHive(): void {
  run = undefined;
  pending = undefined;
  asking = undefined;
  setWriteGate(undefined);
  notify();
}
