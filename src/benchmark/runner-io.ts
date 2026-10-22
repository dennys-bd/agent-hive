// The real I/O behind a benchmark run (#472): 3.1's isolation, 3.3's client, watch, metrics and interventions, 3.6's report. runner.ts merges
// a test's stubs over it, so no test spawns a daemon or runs git.
import { dirname, join } from 'node:path';
import { experimentDir } from '../benchmark-guards.js';
import { workspaceByName } from '../config.js';
import type { Tokens } from '../facts.js';
import { loadState } from '../state-store.js';
import type { Arm, BenchMetrics, BenchRun, Config, Experiment, Intervention, State } from '../types.js';
import { bootRun, type RunningDaemon, type RunningRun, stopRun } from './daemon.js';
import { createDaemonClient, type DaemonClient } from './daemon-client.js';
import { inDir, type Run } from './exec.js';
import { BASELINE_BRANCH, CLONE_DIR, diffShortstat, fetchBranch, resolveBaseline } from './git.js';
import { parseShortstat, readInterventions } from './metrics.js';
import { readModelTokens } from './prices.js';
import { writeReport } from './report-md.js';
import { prepareExperiment, prepareRun } from './run-home.js';
import { type WatchDeps, type WatchResult, type WatchTask, watchRun } from './watcher.js';

export interface RunIo {
  prepareExperiment(experiment: Experiment): Promise<void>;
  prepareRun(experiment: Experiment, arm: Arm, round: number): Promise<BenchRun>;
  boot(home: string, signal: AbortSignal): Promise<RunningDaemon>;
  stop(run: RunningRun, workspace: string): Promise<void>; // daemon down, worktrees gone, run branch kept
  client(home: string): DaemonClient;
  watch(token: string, tasks: WatchTask[], deps: WatchDeps): Promise<WatchResult>; // token: names the run for a test's stub; watchRun ignores it
  savedState(home: string): Promise<Pick<State, 'tasks' | 'activityRecords'>>; // when the daemon no longer answers
  diff(home: string, branch: string): Promise<BenchMetrics['diff']>;
  modelTokens(home: string): Promise<Record<string, Tokens>>;
  interventions(home: string, log: (line: string) => void): Promise<Intervention[]>;
  report(experiment: Experiment): Promise<void>;
}
export interface IoDeps { hiveDir: string; config(): Config | undefined; exec: Run; log(line: string): void; now(): Date }

// As the harness's run-one: the run branch fetched from the run's origin, against the baseline it was cut from (createRunBranches)
async function runDiff(git: Run, branch: string): Promise<BenchMetrics['diff']> {
  await fetchBranch(git, branch);
  return parseShortstat(await diffShortstat(git, await resolveBaseline(git, `origin/${BASELINE_BRANCH}`), branch));
}

export function realIo(o: IoDeps): RunIo {
  const config = (): Config => {
    const current = o.config();
    if (current === undefined) throw new Error('the Hive is not configured');
    return current;
  };
  const isolation = () => ({ hiveDir: o.hiveDir, config: config(), exec: o.exec, log: o.log });
  return {
    prepareExperiment: (experiment) => prepareExperiment(experiment, isolation()),
    prepareRun: (experiment, arm, round) => prepareRun(experiment, arm, round, isolation()),
    boot: (home, signal) => bootRun(home, { signal }),
    stop: (run, workspace) => stopRun(run, { exec: o.exec, nestedRepos: workspaceByName(config(), workspace)?.nestedRepos ?? [] }),
    client: (home) => createDaemonClient(home),
    watch: (_token, tasks, deps) => watchRun(tasks, deps),
    savedState: (home) => loadState(home),
    // a home is <experiment>/runs/<token>; the clone sits beside runs/ (stopRun's rule)
    diff: (home, branch) => runDiff(inDir(o.exec, join(dirname(dirname(home)), CLONE_DIR)), branch),
    modelTokens: readModelTokens,
    interventions: readInterventions,
    report: (experiment) => writeReport(experimentDir(o.hiveDir, experiment.id), experiment, o.now().getTime()),
  };
}
