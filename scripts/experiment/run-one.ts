import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadState } from '../../src/state-store.js';
import { runConfig, runState, watchTasks } from './arm-config.js';
import type { RunningDaemon } from './daemon-runner.js';
import type { Run } from '../../src/benchmark/exec.js';
import { writeJson } from './files.js';
import { createRunBranch, diffShortstat, dropRunWorktrees, fetchBranch } from '../../src/benchmark/git.js';
import { pruneDocs } from './docs-git.js';
import { failedMetrics, parseShortstat, runMetrics } from './metrics.js';
import { runBranch, runHome, runPrefix } from './plan.js';
import { writeHome } from './run-home.js';
import type { Seed } from './seed.js';
import { type Arm, FILES, type Metrics } from './types.js';
import { type WatchClient, type WatchResult, watchRun } from './watcher.js';

export interface RunContext { dir: string; root: string; state: string; baseline: string; docsBaseline: string; token: string; arm: Arm; seed: Seed; runJs: string; timeoutMs: number; unpaired?: boolean }
export interface RunDeps {
  run: Run; // the shared serialGit
  docs: Run; // the same, in the docs clone (git.ts docsClone)
  now(): Date; sleep(ms: number): Promise<void>; log(line: string): void;
  boot(home: string, runJs: string): Promise<RunningDaemon>; stop(daemon: RunningDaemon): Promise<void>;
  client(home: string): WatchClient;
}

async function watched(home: string, ctx: RunContext, deps: RunDeps): Promise<WatchResult> {
  const daemon = await deps.boot(home, ctx.runJs);
  try {
    return await watchRun(watchTasks(ctx.seed.tasks), { client: deps.client(home), now: deps.now, sleep: deps.sleep, log: deps.log, timeoutMs: ctx.timeoutMs });
  } finally {
    await deps.stop(daemon);
  }
}

/** One attempt (#105), beside its pair. Everything is named by the token: branch, home, task prefix, folder.
 *  It runs until every delivery is Done, the timeout passes or an error occurs. Its task worktrees and branches go; the run branch stays,
 *  and so do the docs clone's run branch and task branches, which hold the specs and plans the evaluation reads (#79). */
export async function executeRun(ctx: RunContext, deps: RunDeps): Promise<Metrics> {
  const branch = runBranch(ctx.token);
  const prefix = runPrefix(ctx.token);
  await createRunBranch(deps.run, branch, ctx.baseline);
  await createRunBranch(deps.docs, branch, ctx.docsBaseline);
  await dropRunWorktrees(deps.run, prefix);
  const home = runHome(ctx.state, ctx.token);
  const firstStage = String(ctx.seed.stages.stages[0]?.name);
  await writeHome(home, runConfig(ctx.seed.stages, ctx.arm, branch, ctx.root, prefix, { state: ctx.state, home }), runState(ctx.seed.tasks, firstStage, prefix));
  const startedAt = deps.now().toISOString();
  const { end, watch } = await watched(home, ctx, deps);
  const endedAt = deps.now().toISOString();
  await fetchBranch(deps.run, branch);
  const diff = parseShortstat(await diffShortstat(deps.run, ctx.baseline, branch));
  // The state the daemon saved on stop: its activity records hold the usage and the result of each task (#629)
  const state = await loadState(home);
  const metrics = runMetrics({ token: ctx.token, startedAt, endedAt, end, watch, state, diff, unpaired: ctx.unpaired });
  await mkdir(join(ctx.dir, ctx.token), { recursive: true });
  await writeJson(join(ctx.dir, ctx.token, FILES.metrics), metrics);
  await dropRunWorktrees(deps.run, prefix);
  await pruneDocs(deps.docs);
  return metrics;
}

/** An error run's metrics, unless executeRun already wrote the real ones before it failed. */
export async function recordFailure(dir: string, token: string, reason: string, unpaired: boolean): Promise<void> {
  const path = join(dir, token, FILES.metrics);
  if (existsSync(path)) return;
  await mkdir(join(dir, token), { recursive: true });
  await writeJson(path, failedMetrics(token, new Date().toISOString(), reason, unpaired));
}
