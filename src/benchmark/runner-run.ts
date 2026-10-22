// One benchmark run inside the runner (#472): prepare and boot (startRun), the watch with its progress and slept time (watchOne), its end
// (endRun: metrics, interventions, the two dispatches, then the stop). Every I/O is RunIo's.
import { setTimeout as delay } from 'node:timers/promises';
import { runHome } from '../benchmark-guards.js';
import type { Tokens } from '../facts.js';
import type { Arm, BenchmarkEvent, BenchRun, BenchRunPatch, BenchRunStatus, Experiment } from '../types.js';
import { mergeArm, watchTasks } from './arm-config.js';
import type { DaemonClient } from './daemon-client.js';
import type { RunningRun } from './daemon.js';
import { runBranch } from './git.js';
import { noMetrics, runMetrics } from './metrics.js';
import { newToken } from './run-home.js';
import type { RunIo } from './runner-io.js';
import { gatedClient, type SleepGate, sleptSoFar, untilAwake } from './runner-sleep.js';
import type { RunHandle } from './scheduler.js';
import { type Progress, startWatch, type WatchEnd, type WatchState } from './watcher.js';

export const TOKENS_EVERY_MS = 60_000; // a running run's tokens, for the cap: read at most once a minute
const NO_DIFF = { files: 0, insertions: 0, deletions: 0 };

export interface LiveRun extends RunHandle {
  armId: string; round: number; home: string; startedAt: string; controller: AbortController; // the run's own abort: a wake found its daemon gone
  running?: RunningRun; client?: DaemonClient; // absent when prepare or boot failed
}
export interface RunContext {
  id: string; workspace: string; hiveDir: string; signal: AbortSignal; io: RunIo; gate: SleepGate;
  latest(): Experiment | undefined; dispatch(event: BenchmarkEvent): Promise<unknown>; now(): Date; log(line: string): void;
  ready(): Promise<void>; // prepareExperiment once per loop, shared by a round's arms
  handles: Map<string, LiveRun>; watched: Map<string, WatchState>; tokensAt: Map<string, number>;
}

// A first line only: an error from git or a boot names paths, never a prompt (spec "A run that fails to prepare or boot")
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
const runOf = (experiment: Experiment | undefined, token: string): BenchRun | undefined => experiment?.rounds.flatMap((r) => r.runs).find((r) => r.token === token);
const totalTokens = (byModel: Record<string, Tokens>): number => Object.values(byModel).reduce((sum, t) => sum + t.input + t.output + t.cache_write + t.cache_read, 0);
const runLog = (ctx: RunContext, token: string) => (line: string): void => ctx.log(`benchmark ${ctx.id} ${token}: ${line}`);

// The sleep holds a prepared run before its start: benchmarkRunStarted sets the experiment running, which a sleeping one must not read
async function started(ctx: RunContext, run: BenchRun, controller: AbortController, failed?: string): Promise<LiveRun> {
  await untilAwake(ctx.gate, ctx.signal);
  ctx.signal.throwIfAborted();
  const startedAt = ctx.now().toISOString();
  await ctx.dispatch({ type: 'benchmarkRunStarted', id: ctx.id, run: { ...run, status: 'running', startedAt } });
  runLog(ctx, run.token)(`round ${run.round} started`);
  return { token: run.token, armId: run.armId, round: run.round, home: run.home, startedAt, controller, ...(failed === undefined ? {} : { failed }) };
}

// A run prepareRun never gave a token still gets one, so its round records it as an error run (the harness's failure record)
function unprepared(ctx: RunContext, experiment: Experiment, arm: Arm, round: number): BenchRun {
  const token = newToken(Math.random, new Set(experiment.rounds.flatMap((r) => r.runs.map((x) => x.token))));
  return {
    token, armId: arm.id, round, status: 'queued', home: runHome(ctx.hiveDir, experiment.id, token), branch: runBranch(token),
    sleptMs: 0, delivered: 0, total: mergeArm(experiment.base, arm.overrides).tasks.length, interventions: [],
  };
}

export async function startRun(ctx: RunContext, experiment: Experiment, arm: Arm, round: number): Promise<LiveRun> {
  const controller = new AbortController();
  let prepared: BenchRun;
  try {
    await ctx.ready();
    prepared = await ctx.io.prepareRun(experiment, arm, round);
  } catch (err) {
    return started(ctx, unprepared(ctx, experiment, arm, round), controller, firstLine(err));
  }
  const handle = await started(ctx, prepared, controller);
  try {
    const daemon = await ctx.io.boot(handle.home, AbortSignal.any([ctx.signal, controller.signal]));
    const live: LiveRun = { ...handle, running: { daemon, token: handle.token }, client: ctx.io.client(handle.home) };
    ctx.handles.set(live.token, live);
    return live;
  } catch (err) {
    return { ...handle, failed: firstLine(err) };
  }
}

async function reportProgress(ctx: RunContext, handle: LiveRun, progress: Progress): Promise<void> {
  if (ctx.latest()?.status === 'sleeping') return; // the sleep's status stays until the wake
  const status: BenchRunStatus = progress.waiting ? 'waiting' : 'running';
  await ctx.dispatch({ type: 'benchmarkRunChanged', id: ctx.id, token: handle.token, patch: { delivered: progress.delivered, total: progress.total, status } });
  const at = ctx.now().getTime();
  if (at - (ctx.tokensAt.get(handle.token) ?? Number.NEGATIVE_INFINITY) < TOKENS_EVERY_MS) return;
  ctx.tokensAt.set(handle.token, at);
  const tokens = totalTokens(await ctx.io.modelTokens(handle.home));
  // BenchRun.metrics is the one place the cap reads; the run's end replaces this with runMetrics
  const metrics = runOf(ctx.latest(), handle.token)?.metrics ?? noMetrics();
  await ctx.dispatch({ type: 'benchmarkRunChanged', id: ctx.id, token: handle.token, patch: { metrics: { ...metrics, tokens } } });
}

export async function watchOne(ctx: RunContext, handle: LiveRun): Promise<WatchEnd> {
  const experiment = ctx.latest();
  const arm = experiment?.arms.find((a) => a.id === handle.armId);
  if (experiment === undefined || arm === undefined || handle.client === undefined) return { outcome: 'error', reason: 'the experiment or its arm is gone' };
  const signal = AbortSignal.any([ctx.signal, handle.controller.signal]);
  const log = runLog(ctx, handle.token);
  const result = await ctx.io.watch(handle.token, watchTasks(mergeArm(experiment.base, arm.overrides).tasks), {
    client: gatedClient(handle.client, ctx.gate, signal), now: ctx.now, sleep: (ms) => delay(ms), log, signal,
    timeoutMs: experiment.pace.runTimeoutMs, sleptMs: () => sleptSoFar(ctx.latest(), handle.token, ctx.now()),
    onProgress: (progress) => void reportProgress(ctx, handle, progress).catch(() => log('progress not recorded')),
  });
  ctx.watched.set(handle.token, result.watch);
  return result.end;
}

async function measured(ctx: RunContext, handle: LiveRun, at: string): Promise<BenchRunPatch> {
  const log = runLog(ctx, handle.token);
  const run = runOf(ctx.latest(), handle.token);
  // the live State while the daemon answers; its saved state.json once it does not
  const state = await (handle.client === undefined ? ctx.io.savedState(handle.home) : handle.client.state().catch(() => ctx.io.savedState(handle.home)));
  const diff = await ctx.io.diff(handle.home, run?.branch ?? runBranch(handle.token)).catch(() => { log('diff unread, counted as none'); return NO_DIFF; });
  const { metrics, unpriced } = runMetrics({
    startedAt: handle.startedAt, endedAt: at, sleptMs: run?.sleptMs ?? 0, watch: ctx.watched.get(handle.token) ?? startWatch([]),
    state, diff, modelTokens: await ctx.io.modelTokens(handle.home),
  });
  if (unpriced.length > 0) log(`no price for ${unpriced.join(', ')}`);
  return { metrics, interventions: await ctx.io.interventions(handle.home, log), ...(unpriced.length > 0 ? { unpriced } : {}) };
}

/** Spec "A run's end": metrics in state before the run reads as ended, then the stop. aborted (a Quit, a wake that found it gone): nothing. */
export async function endRun(ctx: RunContext, handle: LiveRun, end: WatchEnd): Promise<void> {
  if (end.outcome === 'aborted') return;
  const at = ctx.now().toISOString();
  const patch: BenchRunPatch = handle.failed === undefined ? await measured(ctx, handle, at) : { metrics: noMetrics() };
  await ctx.dispatch({ type: 'benchmarkRunChanged', id: ctx.id, token: handle.token, patch });
  await ctx.dispatch({ type: 'benchmarkRunEnded', id: ctx.id, token: handle.token, status: end.outcome, at, ...(end.outcome === 'error' ? { reason: end.reason } : {}) });
  ctx.handles.delete(handle.token);
  if (handle.running !== undefined) await ctx.io.stop(handle.running, ctx.workspace).catch(() => runLog(ctx, handle.token)('stop failed'));
}
