// The reducer of state.benchmark (#458): an experiment's life, pure and immutable as orchestrator.ts's. The routes build what needs I/O
// (ids, hashes, the plugin pin) and refuse a wrong transition (3.2 answers 409), so an event here only applies. One that names an unknown
// experiment, arm, token or round returns the state itself, so none() in step leaves everything as it was.
import type { Arm, ArmOverrides, BenchIsolation, BenchmarkEvent, BenchRound, BenchRun, BenchRunStatus, BenchSleep, Experiment, HiveEvent, IsolationRow, State } from './types.js';

// A Record, so tsc refuses a BenchmarkEvent the delegation would miss
const BENCHMARK_EVENTS: Record<BenchmarkEvent['type'], true> = {
  benchmarkCreated: true, benchmarkEdited: true, benchmarkForked: true, benchmarkArchived: true, benchmarkDeleted: true,
  benchmarkArmAdded: true, benchmarkArmEdited: true, benchmarkArmRemoved: true, benchmarkArmsCopied: true,
  benchmarkRunStarted: true, benchmarkRunChanged: true, benchmarkRunEnded: true, benchmarkRoundEnded: true, benchmarkRoundEvaluated: true,
  benchmarkSlept: true, benchmarkWoken: true, benchmarkStopAfterRound: true, benchmarkFinished: true,
};

export const isBenchmarkEvent = (event: HiveEvent): event is BenchmarkEvent => Object.hasOwn(BENCHMARK_EVENTS, event.type);

type ExperimentEvent = Exclude<BenchmarkEvent, { type: 'benchmarkCreated' | 'benchmarkForked' | 'benchmarkDeleted' }>;
type RunEnd = Extract<BenchmarkEvent, { type: 'benchmarkRunEnded' }>;

const withExperiments = (state: State, experiments: Experiment[]): State => ({ ...state, benchmark: { ...state.benchmark, experiments } });
const known = (state: State, id: string): boolean => state.benchmark.experiments.some((e) => e.id === id);

// The route drew the id, so one already held is a replayed event, not a second experiment
const appended = (state: State, experiment: Experiment): State =>
  known(state, experiment.id) ? state : withExperiments(state, [...state.benchmark.experiments, experiment]);

const deleted = (state: State, id: string): State =>
  known(state, id) ? withExperiments(state, state.benchmark.experiments.filter((e) => e.id !== id)) : state;

// An experiment the change left as it was (unknown arm, token or round) keeps the state's reference
function withExperiment(state: State, id: string, change: (experiment: Experiment) => Experiment): State {
  const current = state.benchmark.experiments.find((e) => e.id === id);
  const next = current === undefined ? undefined : change(current);
  if (current === undefined || next === undefined || next === current) return state;
  return withExperiments(state, state.benchmark.experiments.map((e) => (e === current ? next : e)));
}

function withArm(experiment: Experiment, armId: string, change: (arm: Arm) => Arm): Experiment {
  if (!experiment.arms.some((a) => a.id === armId)) return experiment;
  return { ...experiment, arms: experiment.arms.map((a) => (a.id === armId ? change(a) : a)) };
}

const armAdded = (experiment: Experiment, arm: Arm): Experiment =>
  experiment.arms.some((a) => a.id === arm.id) ? experiment : { ...experiment, arms: [...experiment.arms, arm] };

function withoutArmKey<T>(row: IsolationRow<T>, armId: string): IsolationRow<T> {
  if (row.perArm === undefined || !Object.hasOwn(row.perArm, armId)) return row;
  const { [armId]: _removed, ...perArm } = row.perArm;
  return { ...row, perArm };
}

// A removed arm's own values leave every row, so an arm added later under the same id never inherits them
const isolationWithout = (isolation: BenchIsolation, armId: string): BenchIsolation => ({
  environment: withoutArmKey(isolation.environment, armId), network: withoutArmKey(isolation.network, armId),
  permissionMode: withoutArmKey(isolation.permissionMode, armId), allowedTools: withoutArmKey(isolation.allowedTools, armId),
  deniedTools: withoutArmKey(isolation.deniedTools, armId), limits: withoutArmKey(isolation.limits, armId),
  env: withoutArmKey(isolation.env, armId), betweenRounds: withoutArmKey(isolation.betweenRounds, armId),
});

const armRemoved = (experiment: Experiment, armId: string): Experiment =>
  experiment.arms.some((a) => a.id === armId)
    ? { ...experiment, arms: experiment.arms.filter((a) => a.id !== armId), isolation: isolationWithout(experiment.isolation, armId) }
    : experiment;

// overrides: the source's setup without its tasks, the target keeping its own; tasks: only the tasks, absent when the source has none
function copied(source: ArmOverrides, target: ArmOverrides, what: 'overrides' | 'tasks'): ArmOverrides {
  const { tasks: sourceTasks, ...sourceSetup } = source;
  const { tasks: targetTasks, ...targetSetup } = target;
  if (what === 'overrides') return targetTasks === undefined ? sourceSetup : { ...sourceSetup, tasks: targetTasks };
  return sourceTasks === undefined ? targetSetup : { ...targetSetup, tasks: sourceTasks };
}

function armsCopied(experiment: Experiment, from: string, what: 'overrides' | 'tasks', to: string[]): Experiment {
  const source = experiment.arms.find((a) => a.id === from);
  if (source === undefined || !experiment.arms.some((a) => to.includes(a.id))) return experiment;
  return { ...experiment, arms: experiment.arms.map((a) => (to.includes(a.id) ? { ...a, overrides: copied(source.overrides, a.overrides, what) } : a)) };
}

const holds = (runs: BenchRun[], token: string): boolean => runs.some((r) => r.token === token);

function withRun(experiment: Experiment, token: string, change: (run: BenchRun) => BenchRun): Experiment {
  if (!experiment.rounds.some((round) => holds(round.runs, token))) return experiment;
  const rounds = experiment.rounds.map((round) => (holds(round.runs, token) ? { ...round, runs: round.runs.map((r) => (r.token === token ? change(r) : r)) } : round));
  return { ...experiment, rounds };
}

function withRound(experiment: Experiment, n: number, change: (round: BenchRound) => BenchRound): Experiment {
  if (!experiment.rounds.some((round) => round.n === n)) return experiment;
  return { ...experiment, rounds: experiment.rounds.map((round) => (round.n === n ? change(round) : round)) };
}

const placed = (runs: BenchRun[], run: BenchRun): BenchRun[] =>
  holds(runs, run.token) ? runs.map((r) => (r.token === run.token ? run : r)) : [...runs, run];

// The round is the pair: its first run's start opens it
function runStarted(experiment: Experiment, run: BenchRun): Experiment {
  const fresh: BenchRound = { n: run.round, ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }), runs: [] };
  const opened = experiment.rounds.some((round) => round.n === run.round) ? experiment.rounds : [...experiment.rounds, fresh];
  return { ...experiment, status: 'running', rounds: opened.map((round) => (round.n === run.round ? { ...round, runs: placed(round.runs, run) } : round)) };
}

const ended = (run: BenchRun, { status, at, reason }: RunEnd): BenchRun => ({ ...run, status, endedAt: at, ...(reason === undefined ? {} : { reason }) });

const moved = (from: readonly BenchRunStatus[], to: BenchRunStatus) => (run: BenchRun): BenchRun => (from.includes(run.status) ? { ...run, status: to } : run);
const withRuns = (experiment: Experiment, change: (run: BenchRun) => BenchRun): BenchRound[] =>
  experiment.rounds.map((round) => ({ ...round, runs: round.runs.map(change) }));

// A waiting run's Hive sleeps with the rest (3.2), so it sleeps too
const slept = (experiment: Experiment, sleep: Omit<BenchSleep, 'wokeAt'>): Experiment =>
  ({ ...experiment, status: 'sleeping', sleeps: [...experiment.sleeps, sleep], rounds: withRuns(experiment, moved(['running', 'waiting'], 'sleeping')) });

// Every sleeping run wakes as running: one that was waiting is set back by the watcher's next read (3.3)
function woken(experiment: Experiment, at: string): Experiment {
  const open = experiment.sleeps.map((s) => s.wokeAt === undefined).lastIndexOf(true);
  const sleeps = experiment.sleeps.map((s, i) => (i === open ? { ...s, wokeAt: at } : s));
  return { ...experiment, status: 'running', sleeps, rounds: withRuns(experiment, moved(['sleeping'], 'running')) };
}

function withoutStop(experiment: Experiment): Experiment {
  const { stopAfterRound: _stop, ...rest } = experiment;
  return rest;
}

function withArchived(experiment: Experiment, on: boolean): Experiment {
  if (on) return { ...experiment, archived: true };
  const { archived: _archived, ...rest } = experiment;
  return rest;
}

function applied(experiment: Experiment, event: ExperimentEvent): Experiment {
  switch (event.type) {
    // status, rounds and arms are the run's and the arms' own events', even when a route's patch carries them
    case 'benchmarkEdited': return { ...experiment, ...event.patch, status: experiment.status, rounds: experiment.rounds }; // #478: arms come with a draft's replace
    case 'benchmarkArchived': return withArchived(experiment, event.archived);
    case 'benchmarkArmAdded': return armAdded(experiment, event.arm);
    case 'benchmarkArmEdited': return withArm(experiment, event.armId, (a) => ({ ...a, ...event.patch }));
    case 'benchmarkArmRemoved': return armRemoved(experiment, event.armId);
    case 'benchmarkArmsCopied': return armsCopied(experiment, event.from, event.what, event.to);
    case 'benchmarkRunStarted': return runStarted(experiment, event.run);
    case 'benchmarkRunChanged': return withRun(experiment, event.token, (r) => ({ ...r, ...event.patch }));
    case 'benchmarkRunEnded': return withRun(experiment, event.token, (r) => ended(r, event));
    case 'benchmarkRoundEnded': return withRound(experiment, event.round, (r) => ({ ...r, endedAt: event.at }));
    case 'benchmarkRoundEvaluated': return withRound(experiment, event.round, (r) => ({ ...r, evaluatedAt: event.at }));
    case 'benchmarkSlept': return slept(experiment, event.sleep);
    case 'benchmarkWoken': return woken(experiment, event.at);
    case 'benchmarkStopAfterRound': return event.on ? { ...experiment, stopAfterRound: true } : withoutStop(experiment);
    case 'benchmarkFinished': return { ...withoutStop(experiment), status: 'done' };
  }
}

/** state.benchmark after one event of an experiment's life (#458); step in orchestrator.ts delegates every benchmark* event here. */
export function benchmarkReduce(state: State, event: BenchmarkEvent): State {
  switch (event.type) {
    case 'benchmarkCreated': return appended(state, event.experiment);
    case 'benchmarkForked': return known(state, event.from) ? appended(state, event.experiment) : state;
    case 'benchmarkDeleted': return deleted(state, event.id);
    default: {
      const change: ExperimentEvent = event;
      return withExperiment(state, change.id, (experiment) => applied(experiment, change));
    }
  }
}
