// The benchmark's loop (#472): rounds in order, every owed run of a round booted at once, the round ended when every run ended, then its
// evaluation and the report, then the gate for the next. Pure of I/O: every effect is a dep (the harness's runLoop order, its sortPair resume).
import type { Arm, BenchmarkEvent, BenchRunStatus, Experiment } from '../types.js';
import { mayStart } from './deadline.js';
import type { WatchEnd } from './watcher.js';

const ENDED: readonly BenchRunStatus[] = ['done', 'timeout', 'error'];

export interface RunHandle { token: string; failed?: string }
export interface MissingRun { round: number; armId: string }
export interface SchedulerDeps<H extends RunHandle = RunHandle> {
  latest(): Experiment | undefined;
  dispatch(event: BenchmarkEvent): Promise<unknown>;
  now(): Date;
  deadline(): Date | undefined; // untilDeadline(start or wake, pace.until): the runner's
  capReached(): boolean;
  awake(): Promise<void>; // resolves once the experiment does not sleep: no round starts asleep
  startRun(experiment: Experiment, arm: Arm, round: number): Promise<H>; // prepare + boot + client; a failure resolves with `failed`
  watch(handle: H): Promise<WatchEnd>;
  endRun(handle: H, end: WatchEnd): Promise<void>; // metrics, interventions, the two dispatches, the stop
  evaluate(tokens: readonly string[]): Promise<void>; // bench.evaluate, marking the round
  report(): Promise<void>; // writeReport
  log(line: string): void;
  signal: AbortSignal;
}
type RoundDeps = Pick<SchedulerDeps, 'latest' | 'evaluate' | 'report' | 'log'>;

/** The runs the experiment still owes (#472): per round n ≤ pace.pairs and per arm, none yet or the arm's latest one interrupted. Derived,
 *  never stored: the routes' 409s and the loop read the same. */
export function missingRuns(experiment: Experiment): MissingRun[] {
  return Array.from({ length: experiment.pace.pairs }, (_, i) => i + 1).flatMap((n) => {
    const runs = experiment.rounds.find((r) => r.n === n)?.runs ?? [];
    return experiment.arms.flatMap((arm) => {
      const latest = runs.filter((r) => r.armId === arm.id).at(-1);
      return latest === undefined || latest.status === 'interrupted' ? [{ round: n, armId: arm.id }] : [];
    });
  });
}

/** Why no new round starts (root design "Pace"): asked before each round only, so a running round is never cut. */
export function gateRefusal(experiment: Experiment, now: Date, deadline: Date | undefined, capped: boolean): string | undefined {
  if (experiment.stopAfterRound) return 'stop after round';
  if (!mayStart(now, deadline)) return 'the until deadline passed';
  return capped ? 'the spend cap is reached' : undefined;
}

const tokensOf = (experiment: Experiment | undefined): Set<string> => new Set(experiment?.rounds.flatMap((r) => r.runs.map((x) => x.token)));

// The round's ended runs in arm order: evaluate-service marks the round once every one of them is in the call
function endedTokens(experiment: Experiment, n: number): string[] {
  const armIndex = (armId: string): number => experiment.arms.findIndex((a) => a.id === armId);
  const runs = experiment.rounds.find((r) => r.n === n)?.runs ?? [];
  return runs.filter((r) => ENDED.includes(r.status)).sort((a, b) => armIndex(a.armId) - armIndex(b.armId)).map((r) => r.token);
}

// A failed evaluation or report is data, not a reason to stop (the harness's evaluated()); the log names the round only
async function evaluateRound(id: string, n: number, deps: RoundDeps): Promise<void> {
  const experiment = deps.latest();
  const tokens = experiment === undefined ? [] : endedTokens(experiment, n);
  try {
    if (tokens.length > 0) await deps.evaluate(tokens);
  } catch {
    deps.log(`benchmark ${id}: round ${n}: evaluation failed`);
  }
  try {
    await deps.report();
  } catch {
    deps.log(`benchmark ${id}: round ${n}: report failed`);
  }
}

// A round that ended before the walk's first owed one but was never evaluated (a Quit between its end and its evaluation) is evaluated
// first; `done` keeps a failed evaluation from being retried in the same loop
async function evaluatePending(experiment: Experiment, before: number, done: Set<number>, deps: RoundDeps): Promise<void> {
  const pending = experiment.rounds.filter((r) => r.n < before && r.evaluatedAt === undefined && !done.has(r.n) && endedTokens(experiment, r.n).length > 0);
  for (const round of pending.sort((a, b) => a.n - b.n)) {
    done.add(round.n);
    await evaluateRound(experiment.id, round.n, deps);
  }
}

async function oneRun<H extends RunHandle>(experiment: Experiment, arm: Arm, n: number, deps: SchedulerDeps<H>): Promise<void> {
  const handle = await deps.startRun(experiment, arm, n);
  try {
    const end: WatchEnd = handle.failed === undefined ? await deps.watch(handle) : { outcome: 'error', reason: handle.failed };
    // aborted: a Quit, or a run the wake found gone (marked interrupted by the runner); never an end
    if (end.outcome === 'aborted' || deps.signal.aborted) return;
    await deps.endRun(handle, end);
    deps.log(`benchmark ${experiment.id} ${handle.token}: round ${n}: ${end.outcome}`);
  } catch {
    // a run that cannot be watched or ended must not stay running: its round would wait on it for ever. The reason is fixed: an error can carry a path
    deps.log(`benchmark ${experiment.id} ${handle.token}: round ${n}: the run could not be ended`);
    if (deps.signal.aborted) return;
    await deps.dispatch({ type: 'benchmarkRunEnded', id: experiment.id, token: handle.token, status: 'error', at: deps.now().toISOString(), reason: 'the run could not be ended' }).catch(() => undefined);
  }
}

async function runRound<H extends RunHandle>(experiment: Experiment, n: number, deps: SchedulerDeps<H>): Promise<void> {
  const owed = new Set(missingRuns(experiment).filter((m) => m.round === n).map((m) => m.armId));
  const arms = experiment.arms.filter((a) => owed.has(a.id));
  deps.log(`benchmark ${experiment.id}: round ${n}: ${arms.length} runs start`);
  // allSettled: a run that cannot start must not leave its pair's runs unwatched
  const settled = await Promise.allSettled(arms.map((arm) => oneRun(experiment, arm, n, deps)));
  if (deps.signal.aborted) return;
  if (settled.some((s) => s.status === 'rejected')) deps.log(`benchmark ${experiment.id}: round ${n}: a run could not start`);
  await deps.dispatch({ type: 'benchmarkRoundEnded', id: experiment.id, round: n, at: deps.now().toISOString() });
  await evaluateRound(experiment.id, n, deps);
}

async function finish(id: string, deps: Pick<SchedulerDeps, 'latest' | 'dispatch' | 'log' | 'awake'>): Promise<void> {
  await deps.awake(); // a sleep that landed during the last evaluation: finishing now would leave an open sleep on a done experiment
  const experiment = deps.latest();
  const owed = experiment === undefined ? [] : missingRuns(experiment);
  const rounds = [...new Set(owed.map((m) => m.round))];
  deps.log(owed.length === 0 ? `benchmark ${id}: done` : `benchmark ${id}: done with ${owed.length} runs missing (rounds ${rounds.join(', ')})`);
  await deps.dispatch({ type: 'benchmarkFinished', id });
}

/** Rounds 1 … pace.pairs in order, from the first that owes a run (#472). An abort returns without another dispatch. */
export async function runExperiment<H extends RunHandle>(id: string, deps: SchedulerDeps<H>): Promise<void> {
  const evaluated = new Set<number>();
  for (;;) {
    const experiment = deps.latest();
    if (experiment === undefined || deps.signal.aborted) return;
    const next = missingRuns(experiment)[0]?.round;
    await evaluatePending(experiment, next ?? Number.POSITIVE_INFINITY, evaluated, deps);
    if (next === undefined) {
      await deps.awake();
      // a more-rounds that landed during the evaluation or the sleep still runs
      if (deps.signal.aborted) return;
      if (missingRuns(deps.latest() ?? experiment).length > 0) continue;
      break;
    }
    await deps.awake();
    if (deps.signal.aborted) return;
    const current = deps.latest() ?? experiment;
    const refusal = gateRefusal(current, deps.now(), deps.deadline(), deps.capReached());
    if (refusal !== undefined) {
      deps.log(`benchmark ${id}: no new round: ${refusal}`);
      break;
    }
    const before = tokensOf(current);
    await runRound(current, next, deps);
    if (deps.signal.aborted) return;
    evaluated.add(next);
    // a wake that found every live run gone leaves the round owing as many runs, yet those are rerun with new tokens: progress is a new run
    if ([...tokensOf(deps.latest())].every((token) => before.has(token))) {
      deps.log(`benchmark ${id}: round ${next} started no run`);
      break;
    }
  }
  await finish(id, deps);
}
