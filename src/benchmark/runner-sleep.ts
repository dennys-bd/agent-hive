// The experiment's sleep and wake (#472) through a run daemon's existing routes, none added: POST /ptys/sleep once per activity (the route
// refuses ids of two activities), then POST /activities/:id/continue for every activity the sleep left stopped (cause all: no respawn).
import type { BenchmarkEvent, BenchRun, BenchRunStatus, BenchSleep, Experiment } from '../types.js';
import type { DaemonClient } from './daemon-client.js';
import type { Snapshot, WatchClient } from './watcher.js';

export type WakeDeadline = 'finish-round' | { until: string } | 'none';
const SLEPT: readonly BenchRunStatus[] = ['running', 'waiting', 'sleeping'];
const UNFINISHED: readonly BenchRunStatus[] = ['queued', ...SLEPT];

export interface SleepGate { wait(): Promise<void>; close(): void; open(): void; isClosed(): boolean; epoch(): number }

export function createGate(): SleepGate {
  let held: { promise: Promise<void>; release: () => void } | undefined;
  let closes = 0;
  return {
    wait: () => held?.promise ?? Promise.resolve(),
    close: () => {
      if (held !== undefined) return;
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      held = { promise, release };
      closes += 1;
    },
    open: () => {
      held?.release();
      held = undefined;
    },
    isClosed: () => held !== undefined,
    epoch: () => closes,
  };
}

/** Resolves once the gate is open or the signal aborted, whichever comes first. */
export async function untilAwake(gate: SleepGate, signal: AbortSignal): Promise<void> {
  if (!gate.isClosed() || signal.aborted) return;
  await Promise.race([gate.wait(), new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))]);
}

// The watcher reads a stopped activity as a run that ended without hive_done (3.3), and a sleep stops them all: while the experiment
// sleeps the watch reads nothing, and a state taken across a sleep is read again after the wake, which continued the activities first
export function gatedClient(client: WatchClient, gate: SleepGate, signal: AbortSignal): WatchClient {
  const awake = async (): Promise<void> => {
    await untilAwake(gate, signal);
    signal.throwIfAborted();
  };
  return {
    state: async () => {
      for (;;) {
        await awake();
        const epoch = gate.epoch();
        const snapshot = await client.state();
        if (!gate.isClosed() && gate.epoch() === epoch) return snapshot;
      }
    },
    setAuto: async (itemId) => { await awake(); await client.setAuto(itemId); },
    setGreen: async () => { await awake(); await client.setGreen(); },
    interventions: async () => { await awake(); return client.interventions(); },
  };
}

/** The live stage runs' ids per activity: what POST /ptys/sleep takes in one call. A free session is the user's, not the run's. */
export function sleepGroups(snapshot: Snapshot): string[][] {
  const groups = new Map<string, string[]>();
  for (const w of snapshot.workers) {
    if (w.status === 'empty' || w.freeSession || w.runId === undefined || w.activityId === undefined) continue;
    groups.set(w.activityId, [...(groups.get(w.activityId) ?? []), w.runId]);
  }
  return [...groups.values()];
}

export async function sleepDaemon(client: Pick<DaemonClient, 'state' | 'sleepRuns'>): Promise<void> {
  for (const ptyIds of sleepGroups(await client.state())) await client.sleepRuns(ptyIds);
}

export async function wakeDaemon(client: Pick<DaemonClient, 'state' | 'continueActivity'>): Promise<void> {
  const snapshot = await client.state();
  for (const activity of snapshot.activities.filter((a) => a.stopped)) await client.continueActivity(activity.id);
}

const runsOf = (experiment: Experiment): BenchRun[] => experiment.rounds.flatMap((r) => r.runs);
const openSleep = (experiment: Experiment): BenchSleep | undefined => [...experiment.sleeps].reverse().find((s) => s.wokeAt === undefined);

// A run started after the sleep began (its boot was in flight) slept only from its start
const spanOf = (sleep: BenchSleep, run: BenchRun, at: Date): number =>
  Math.max(0, at.getTime() - Math.max(Date.parse(sleep.at), run.startedAt === undefined ? 0 : Date.parse(run.startedAt)));

/** The watch's sleptMs() (#473): the run's recorded sleep, plus the open one while the experiment sleeps. */
export function sleptSoFar(experiment: Experiment | undefined, token: string, now: Date): number {
  const run = experiment === undefined ? undefined : runsOf(experiment).find((r) => r.token === token);
  if (run === undefined) return 0;
  const open = experiment?.status === 'sleeping' && SLEPT.includes(run.status) ? openSleep(experiment) : undefined;
  return open === undefined ? run.sleptMs : run.sleptMs + spanOf(open, run, now);
}

/** The wake's events (spec "Wake"): the open sleep's span added to every slept run's sleptMs, then benchmarkWoken. Read before the dispatch.
 *  The patches go first: while the sleep is open the timeout clock adds its span, so the gap between the two can only count slept time twice
 *  (a later timeout), never leave it out (an early one). */
export function wokenEvents(experiment: Experiment, at: Date): BenchmarkEvent[] {
  const open = openSleep(experiment);
  const patches = open === undefined ? [] : runsOf(experiment).filter((r) => SLEPT.includes(r.status)).map((r): BenchmarkEvent =>
    ({ type: 'benchmarkRunChanged', id: experiment.id, token: r.token, patch: { sleptMs: r.sleptMs + spanOf(open, r, at) } }));
  return [...patches, { type: 'benchmarkWoken', id: experiment.id, at: at.toISOString() }];
}

/** The wake dialog's options (2.8): absent keeps the deadline, and the cap stays as it is. */
export function deadlineEvents(experiment: Experiment, deadline: WakeDeadline | undefined): BenchmarkEvent[] {
  if (deadline === undefined) return [];
  if (deadline === 'finish-round') return [{ type: 'benchmarkStopAfterRound', id: experiment.id, on: true }];
  if (deadline === 'none') {
    const { until: _until, ...pace } = experiment.pace;
    return [{ type: 'benchmarkEdited', id: experiment.id, patch: { pace } }];
  }
  return [{ type: 'benchmarkEdited', id: experiment.id, patch: { pace: { ...experiment.pace, until: deadline.until } } }];
}

/** Every unfinished run as #458's boot guard leaves one: interrupted, so the loop reruns it with a new token. */
export const interruptedEvents = (experiment: Experiment): BenchmarkEvent[] =>
  runsOf(experiment).filter((r) => UNFINISHED.includes(r.status)).map((r) => ({ type: 'benchmarkRunChanged', id: experiment.id, token: r.token, patch: { status: 'interrupted' } }));

// ponytail: the highest round; a rerun of an earlier round during a later one records the later's number
export const currentRound = (experiment: Experiment): number => Math.max(1, ...experiment.rounds.map((r) => r.n));
