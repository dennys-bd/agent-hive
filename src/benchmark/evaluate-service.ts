// The benchmark's evaluations (#474): one at a time per call, in the caller's order; one AbortController per call (a Quit's abortAll); the
// tokens being evaluated, so a second POST answers 409. Nothing survives the Hive: the set dies with it, and nothing needs cleaning at boot.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { type HeadlessDeps, runHeadless } from '../headless-run.js';
import type { Logger } from '../log.js';
import type { BenchmarkEvent, BenchRunEvaluation, BenchRunStatus, State } from '../types.js';
import { ensureChromium, mcpBinary } from './browser.js';
import { type EvaluateContext, type EvaluateDeps, evaluateRun } from './evaluate.js';
import { type Run, serialGit } from './exec.js';

const ENDED: readonly BenchRunStatus[] = ['done', 'timeout', 'error'];

export interface BenchEvaluatorDeps {
  latest(): State | undefined;
  dispatch(event: BenchmarkEvent): Promise<unknown>;
  folderOf(experimentId: string): string;
  log: Pick<Logger, 'info' | 'warn'>;
  now(): number;
  runDeps(signal: AbortSignal, log: (line: string) => void): EvaluateDeps;
  evaluateRun?: (ctx: EvaluateContext, deps: EvaluateDeps) => Promise<BenchRunEvaluation | undefined>; // tests' seam
}
/** The bench.evaluate contract 3.2 consumes. */
export interface BenchEvaluator { evaluate(experimentId: string, tokens: readonly string[], markRounds?: boolean): Promise<void>; isEvaluating(token: string): boolean; abortAll(): Promise<void> }

export function createBenchEvaluator(deps: BenchEvaluatorDeps): BenchEvaluator {
  const evaluating = new Set<string>();
  const controllers = new Set<AbortController>();
  const inFlight = new Set<Promise<void>>(); // a Quit awaits them: their finally blocks stop the sample and remove the eval worktree
  const evaluateOne = deps.evaluateRun ?? evaluateRun;

  async function one(id: string, token: string, signal: AbortSignal): Promise<boolean> {
    const experiment = deps.latest()?.benchmark.experiments.find((e) => e.id === id);
    const run = experiment?.rounds.flatMap((r) => r.runs).find((r) => r.token === token);
    if (experiment === undefined || run === undefined) return false;
    const log = (line: string): void => deps.log.info(`benchmark ${id} ${token}: ${line}`);
    try {
      const evaluation = await evaluateOne({ experiment, run, folder: deps.folderOf(id) }, deps.runDeps(signal, log));
      if (signal.aborted) return false;
      if (evaluation !== undefined) {
        await deps.dispatch({ type: 'benchmarkRunChanged', id, token, patch: { evaluation } });
        return true;
      }
    } catch {
      if (signal.aborted) return false; // a Quit's abort, never a failure to report
    }
    deps.log.warn(`benchmark ${id} ${token}: evaluation failed`); // the token only: a reason can carry a path, a diff or a prompt
    return false;
  }

  async function markRounds(id: string, done: ReadonlySet<string>): Promise<void> {
    const experiment = deps.latest()?.benchmark.experiments.find((e) => e.id === id);
    const at = new Date(deps.now()).toISOString();
    for (const round of experiment?.rounds ?? []) {
      const ended = round.runs.filter((r) => ENDED.includes(r.status));
      if (ended.length > 0 && ended.every((r) => done.has(r.token))) await deps.dispatch({ type: 'benchmarkRoundEvaluated', id, round: round.n, at });
    }
  }

  async function run(id: string, tokens: readonly string[], markRound: boolean): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    for (const token of tokens) evaluating.add(token); // before the first await: the route's next POST already sees them
    try {
      const done = new Set<string>();
      for (const token of tokens) {
        if (controller.signal.aborted) return;
        if (await one(id, token, controller.signal)) done.add(token);
      }
      if (markRound && !controller.signal.aborted) await markRounds(id, done); // only the experiment route, per the spec
    } finally {
      for (const token of tokens) evaluating.delete(token);
      controllers.delete(controller);
    }
  }

  function evaluate(id: string, tokens: readonly string[], markRound = false): Promise<void> {
    const promise = run(id, tokens, markRound);
    inFlight.add(promise);
    const forget = (): void => { inFlight.delete(promise); };
    promise.then(forget, forget);
    return promise;
  }

  async function abortAll(): Promise<void> {
    for (const c of controllers) c.abort();
    await Promise.allSettled([...inFlight]);
  }

  return { evaluate, isEvaluating: (token) => evaluating.has(token), abortAll };
}

/** The readiness poll reads the status only: the body is cancelled so no socket stays held until the next poll. */
export async function readyFetch(url: string, init: { signal: AbortSignal }, fetchImpl: typeof fetch = fetch): Promise<{ status: number }> {
  const res = await fetchImpl(url, init);
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status };
}

/** The real processes behind an evaluation; the git runner is the caller's (a test or the Hive's). */
export function benchRunDeps(o: { exec: Run; headless?: HeadlessDeps }): BenchEvaluatorDeps['runDeps'] {
  const exec = serialGit(o.exec); // one runner for every evaluation: concurrent ones share the clone
  return (signal, log) => ({
    exec, headless: (input) => runHeadless(input, o.headless), browser: { ensureChromium: () => ensureChromium(), mcpBinary },
    spawnSample: spawn, kill: (pid, s) => process.kill(pid, s), fetch: (url, init) => readyFetch(url, init), now: Date.now,
    sleep: (ms) => sleep(ms, undefined, { signal }), log, signal, tmpRoot: tmpdir(),
  });
}
