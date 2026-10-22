// The benchmark's runner (#472), one per Hive, created in server.ts beside the evaluator. Per live experiment: an AbortController, the sleep
// gate and the live runs (its RunContext), and the deadline; the wakeAt timers apart. Nothing survives the Hive: a Quit aborts every loop,
// and the boot guard (#458) leaves what ran interrupted for `run` to resume.
import { setTimeout as delay } from 'node:timers/promises';
import { experimentDir } from '../benchmark-guards.js';
import type { Logger } from '../log.js';
import type { BenchmarkEvent, Config, Experiment, State } from '../types.js';
import { capReached } from './cap.js';
import { untilDeadline } from './deadline.js';
import { ABORT_WAIT_MS, type BenchEvaluator } from './evaluate-service.js';
import { execRun, type Run, serialGit } from './exec.js';
import { type LockDeps, releaseLock, takeLock } from './run-lock.js';
import { blindnessLeak, blindnessMessage } from './run-home.js';
import { realIo, type RunIo } from './runner-io.js';
import { endRun, type LiveRun, type RunContext, startRun, watchOne } from './runner-run.js';
import { createGate, currentRound, deadlineEvents, interruptedEvents, sleepDaemon, untilAwake, type WakeDeadline, wakeDaemon, wokenEvents } from './runner-sleep.js';
import { missingRuns, runExperiment, type SchedulerDeps } from './scheduler.js';

export type StartAnswer = 'started' | 'live' | 'locked';
export interface BenchRunner {
  run(id: string): Promise<StartAnswer>; // takes the lock and starts the loop in the background
  sleep(id: string, reason: string, wakeAt?: string): Promise<void>;
  wake(id: string, deadline?: WakeDeadline): Promise<void>;
  isLive(id: string): boolean;
  blindness(experiment: Experiment): Promise<string | undefined>; // blindnessMessage of the first leak across the arms missingRuns names
  abortAll(): Promise<void>; // a Quit: every loop aborted (its daemons stop through bootRun's signal), bounded wait
}
export interface BenchRunnerDeps {
  latest(): State | undefined; config(): Config | undefined; dispatch(event: BenchmarkEvent): Promise<unknown>;
  hiveDir: string; evaluator: Pick<BenchEvaluator, 'evaluate'>; log: Pick<Logger, 'info' | 'warn'>; now(): Date;
  exec?: Run; // serialized here: the runs of a round prepare on one clone at once (prepareRun's note)
  io?: Partial<RunIo>; // tests' seam
  schedule?(ms: number, wake: () => void): () => void; // tests' seam: the wakeAt timer, answering its cancel
  lock?: LockDeps; // tests' seam
  abortWaitMs?: number; // tests' seam
}

interface LiveExperiment { ctx: RunContext; controller: AbortController; deadline: Date | undefined; done: Promise<void> }
interface Runtime { deps: BenchRunnerDeps; io: RunIo; live: Map<string, LiveExperiment>; timers: Map<string, () => void>; waking: Map<string, Promise<void>>; closing: boolean }

const experimentOf = (rt: Runtime, id: string): Experiment | undefined => rt.deps.latest()?.benchmark.experiments.find((e) => e.id === id);
const deadlineOf = (experiment: Experiment, now: Date): Date | undefined => (experiment.pace.until === undefined ? undefined : untilDeadline(now, experiment.pace.until));
const dispatchAll = async (rt: Runtime, events: readonly BenchmarkEvent[]): Promise<void> => { for (const event of events) await rt.deps.dispatch(event); };

// `absent` and finish-round keep the deadline the loop took (decomposition: "absent = keep the deadline"); a new until is the next HH:MM
function nextDeadline(current: Date | undefined, deadline: WakeDeadline | undefined, at: Date): Date | undefined {
  if (deadline === 'none') return undefined;
  if (typeof deadline === 'object') return untilDeadline(at, deadline.until);
  return current;
}

function contextOf(rt: Runtime, experiment: Experiment, controller: AbortController): RunContext {
  let ready: Promise<void> | undefined;
  return {
    id: experiment.id, workspace: experiment.seed.workspace, hiveDir: rt.deps.hiveDir, signal: controller.signal, io: rt.io, gate: createGate(),
    latest: () => experimentOf(rt, experiment.id), dispatch: rt.deps.dispatch, now: rt.deps.now, log: (line) => rt.deps.log.info(line),
    // once per loop, shared by a round's arms; a failure is each arm's error run, and the next round prepares again
    ready: () => (ready ??= rt.io.prepareExperiment(experiment).catch((err: unknown) => { ready = undefined; throw err; })),
    handles: new Map(), watched: new Map(), tokensAt: new Map(), progress: new Map(),
  };
}

function schedulerDeps(rt: Runtime, entry: LiveExperiment): SchedulerDeps<LiveRun> {
  const { ctx } = entry;
  return {
    latest: ctx.latest, dispatch: ctx.dispatch, now: ctx.now, log: ctx.log, signal: ctx.signal,
    deadline: () => rt.live.get(ctx.id)?.deadline,
    capReached: () => { const experiment = ctx.latest(); return experiment !== undefined && capReached(experiment, rt.deps.latest()?.rateLimits); },
    awake: () => untilAwake(ctx.gate, ctx.signal),
    startRun: (experiment, arm, round) => startRun(ctx, experiment, arm, round),
    watch: (handle) => watchOne(ctx, handle),
    endRun: (handle, end) => endRun(ctx, handle, end),
    evaluate: (tokens) => rt.deps.evaluator.evaluate(ctx.id, tokens, true),
    report: async () => { const experiment = ctx.latest(); if (experiment !== undefined) await rt.io.report(experiment); },
  };
}

// What the boot guard does (#458) when the loop itself fails: its runs stop, the unfinished ones interrupted, the experiment done
async function failLoop(rt: Runtime, entry: LiveExperiment): Promise<void> {
  entry.controller.abort();
  const experiment = experimentOf(rt, entry.ctx.id);
  if (experiment === undefined) return;
  await dispatchAll(rt, interruptedEvents(experiment));
  await rt.deps.dispatch({ type: 'benchmarkFinished', id: entry.ctx.id });
}

async function loop(rt: Runtime, entry: LiveExperiment): Promise<void> {
  const { id } = entry.ctx;
  try {
    await runExperiment(id, schedulerDeps(rt, entry));
  } catch {
    rt.deps.log.warn(`benchmark ${id}: the loop failed`); // no message: it can carry a path or git's words
    if (!entry.controller.signal.aborted) await failLoop(rt, entry).catch(() => undefined);
  } finally {
    // the lock goes first: a run that reads this experiment not live must find the lock free
    await releaseLock(experimentDir(rt.deps.hiveDir, id)).catch(() => undefined);
    rt.live.delete(id);
  }
}

async function start(rt: Runtime, id: string): Promise<StartAnswer> {
  if (rt.live.has(id)) return 'live';
  const experiment = experimentOf(rt, id);
  if (rt.closing || experiment === undefined) return 'locked';
  const controller = new AbortController();
  const pending: LiveExperiment = { ctx: contextOf(rt, experiment, controller), controller, deadline: undefined, done: Promise.resolve() };
  rt.live.set(id, pending); // before the lock's await: a second click already reads live
  // an I/O error rejects (the route answers 500): it is not another Hive running
  const taken = await takeLock(experimentDir(rt.deps.hiveDir, id), rt.deps.lock).catch((err: unknown) => { rt.live.delete(id); throw err; });
  if (!taken) {
    rt.live.delete(id);
    return 'locked';
  }
  const entry: LiveExperiment = { ...pending, deadline: deadlineOf(experiment, rt.deps.now()) };
  rt.live.set(id, { ...entry, done: loop(rt, entry) });
  return 'started';
}

const realSchedule = (ms: number, wake: () => void): (() => void) => {
  const timer = setTimeout(wake, ms);
  timer.unref(); // a pending wake never keeps the Hive from quitting; a restart drops it (spec "Sleep")
  return () => clearTimeout(timer);
};

function scheduleWake(rt: Runtime, id: string, wakeAt: string): void {
  rt.timers.get(id)?.();
  const now = rt.deps.now();
  const cancel = (rt.deps.schedule ?? realSchedule)(untilDeadline(now, wakeAt).getTime() - now.getTime(), () => {
    rt.timers.delete(id);
    void wake(rt, id).catch(() => rt.deps.log.warn(`benchmark ${id}: the scheduled wake failed`));
  });
  rt.timers.set(id, cancel);
}

async function sleepRun(rt: Runtime, id: string, run: LiveRun): Promise<void> {
  if (run.client === undefined) return;
  try {
    await sleepDaemon(run.client);
  } catch {
    rt.deps.log.warn(`benchmark ${id} ${run.token}: the daemon did not answer the sleep`);
  }
}

async function sleep(rt: Runtime, id: string, reason: string, wakeAt?: string): Promise<void> {
  const experiment = experimentOf(rt, id);
  if (experiment === undefined) return;
  const entry = rt.live.get(id);
  // already asleep (a double click, or one racing the other): a second sleep would record a second span. The gate is closed before the first await
  if (experiment.status === 'sleeping' || entry?.ctx.gate.isClosed()) return;
  entry?.ctx.gate.close(); // before the dispatch: no watch reads a session the sleep is stopping
  try {
    await rt.deps.dispatch({ type: 'benchmarkSlept', id, sleep: { round: currentRound(experiment), at: rt.deps.now().toISOString(), reason } });
  } catch (err) {
    entry?.ctx.gate.open(); // the experiment is not asleep: nothing else would reopen the gate
    throw err;
  }
  await Promise.all([...(entry?.ctx.handles.values() ?? [])].map((run) => sleepRun(rt, id, run)));
  if (wakeAt !== undefined) scheduleWake(rt, id, wakeAt);
}

// A run whose daemon does not answer the wake is rerun with a new token (the boot guard's rule): its watch ends aborted, so its round
// still owes it and the scheduler boots it again once the round's other runs ended
async function interrupt(rt: Runtime, entry: LiveExperiment, run: LiveRun): Promise<void> {
  rt.deps.log.warn(`benchmark ${entry.ctx.id} ${run.token}: the daemon did not answer the wake, interrupted`);
  entry.ctx.handles.delete(run.token);
  await rt.deps.dispatch({ type: 'benchmarkRunChanged', id: entry.ctx.id, token: run.token, patch: { status: 'interrupted' } });
  run.controller.abort();
  if (run.running !== undefined) await rt.io.stop(run.running, entry.ctx.workspace).catch(() => undefined);
}

async function wakeRuns(rt: Runtime, entry: LiveExperiment): Promise<void> {
  await Promise.all([...entry.ctx.handles.values()].map(async (run) => {
    try {
      if (run.client !== undefined) await wakeDaemon(run.client);
    } catch {
      await interrupt(rt, entry, run);
    }
  }));
}

async function resume(rt: Runtime, id: string): Promise<void> {
  const answer = await start(rt, id);
  if (answer === 'started') return;
  rt.deps.log.warn(`benchmark ${id}: woken but not resumed (${answer})`);
  if (answer === 'live') return; // its loop is running: it is not finished
  await rt.deps.dispatch({ type: 'benchmarkFinished', id });
}

// One wake at a time per experiment: a second click, or the wakeAt timer racing a manual wake, gets the first one's promise
function wake(rt: Runtime, id: string, deadline?: WakeDeadline): Promise<void> {
  const inflight = rt.waking.get(id);
  if (inflight !== undefined) return inflight;
  const woken = wakeOnce(rt, id, deadline).finally(() => rt.waking.delete(id));
  rt.waking.set(id, woken);
  return woken;
}

async function wakeOnce(rt: Runtime, id: string, deadline?: WakeDeadline): Promise<void> {
  rt.timers.get(id)?.();
  rt.timers.delete(id);
  const asleep = experimentOf(rt, id);
  if (asleep?.status !== 'sleeping') return; // a wakeAt timer that fires after a manual wake
  const entry = rt.live.get(id);
  // After a restart the sleep's daemons died with the Hive (#458 left it sleeping): every unfinished run is rerun
  if (entry === undefined) await dispatchAll(rt, interruptedEvents(asleep));
  await dispatchAll(rt, wokenEvents(experimentOf(rt, id) ?? asleep, rt.deps.now()));
  if (entry !== undefined) await wakeRuns(rt, entry);
  await dispatchAll(rt, deadlineEvents(experimentOf(rt, id) ?? asleep, deadline));
  if (entry === undefined) return resume(rt, id);
  const current = rt.live.get(id);
  if (current !== undefined) rt.live.set(id, { ...current, deadline: nextDeadline(current.deadline, deadline, rt.deps.now()) });
  entry.ctx.gate.open();
}

async function blindness(rt: Runtime, experiment: Experiment): Promise<string | undefined> {
  const armIds = new Set(missingRuns(experiment).map((m) => m.armId));
  for (const arm of experiment.arms.filter((a) => armIds.has(a.id))) {
    try {
      const leak = await blindnessLeak(experiment, arm, { hiveDir: rt.deps.hiveDir });
      if (leak !== undefined) return blindnessMessage(leak);
    } catch {
      rt.deps.log.warn(`benchmark ${experiment.id}: the blindness check could not read arm ${arm.id}; prepareRun checks again`);
    }
  }
  return undefined;
}

async function abortAll(rt: Runtime): Promise<void> {
  rt.closing = true;
  for (const cancel of rt.timers.values()) cancel();
  rt.timers.clear();
  const entries = [...rt.live.values()];
  for (const entry of entries) {
    entry.controller.abort(); // bootRun's listener stops each run's daemon
    entry.ctx.gate.open();
  }
  const timer = new AbortController();
  const timedOut = delay(rt.deps.abortWaitMs ?? ABORT_WAIT_MS, true, { signal: timer.signal }).catch(() => false);
  const settled = Promise.allSettled(entries.map((e) => e.done)).then(() => false);
  if (await Promise.race([settled, timedOut])) rt.deps.log.warn('benchmark runs did not stop in time'); // fixed line: no free text
  timer.abort();
}

export function createBenchRunner(deps: BenchRunnerDeps): BenchRunner {
  const exec = serialGit(deps.exec ?? execRun); // the runs of a round prepare on one clone at once
  const io: RunIo = { ...realIo({ hiveDir: deps.hiveDir, config: deps.config, exec, log: (line) => deps.log.info(line), now: deps.now }), ...deps.io };
  const rt: Runtime = { deps, io, live: new Map(), timers: new Map(), waking: new Map(), closing: false };
  return {
    run: (id) => start(rt, id), sleep: (id, reason, wakeAt) => sleep(rt, id, reason, wakeAt), wake: (id, deadline) => wake(rt, id, deadline),
    isLive: (id) => rt.live.has(id), blindness: (experiment) => blindness(rt, experiment), abortAll: () => abortAll(rt),
  };
}
