import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopDaemon } from '../../src/daemon.js';
import { DEFAULT_BASELINE, DEFAULT_RUNS, type ExperimentOptions, parseExperimentArgs } from './args.js';
import { createDaemonClient } from './daemon-client.js';
import { untilDeadline } from './deadline.js';
import { evaluateRun } from './evaluate-run.js';
import { execRun, type Run, serialGit } from './exec.js';
import { readJson, type Store, serialStore, writeJson } from './files.js';
import { dropRunWorktrees, experimentBaseline, repoRoot, resolveBaseline, sandboxPaths, unsignedCommits } from './git.js';
import { installSandbox, sandboxSettings } from './sandbox.js';
import { endAttempt, experimentDir, isMeasured, latest, newExperimentId, newManifest, newToken, openAttempts, parseManifest, resumeManifest, runHome, runPrefix, startAttempt, stateRoot } from './plan.js';
import { writeReport } from './report.js';
import { prepareState } from './run-home.js';
import { runLoop } from './run-loop.js';
import { executeRun, recordFailure } from './run-one.js';
import { handoffFiles, loadSeed, type Seed, seedHash } from './seed.js';
import { FILES, type Manifest, type Outcome, type RunRef } from './types.js';
import { boot, evalDeps, log, stop, stopOnInterrupt } from './wiring.js';

const RUN_JS = fileURLToPath(new URL('../../src/run.js', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Night { root: string; state: string; dir: string; store: Store<Manifest>; seed: Seed; opts: ExperimentOptions; git: Run; sandbox: { gitDir: string; origin: string } }

// An attempt the last call left open: its daemon stopped if still alive, its task worktrees and branches gone; its run branch stays
async function dropInterrupted(state: string, token: string, git: Run): Promise<void> {
  await stopDaemon(runHome(state, token)).catch(() => false);
  await dropRunWorktrees(git, runPrefix(token)).catch(() => undefined);
  log(`${token} was interrupted: its slot starts over with a new token`);
}

async function openStore(state: string, dir: string, id: string, opts: ExperimentOptions, git: Run): Promise<Store<Manifest>> {
  const path = join(dir, FILES.manifest);
  const hash = await seedHash();
  const existing = await readJson(path, parseManifest);
  if (existing) {
    if (opts.baseline !== undefined) throw new Error('--baseline is fixed when an experiment is created');
    const resumed = resumeManifest(existing, hash, opts.runs);
    for (const a of openAttempts(existing)) await dropInterrupted(state, a.token, git);
    await writeJson(path, resumed);
    return serialStore(path, resumed);
  }
  const source = await resolveBaseline(git, opts.baseline ?? DEFAULT_BASELINE);
  await mkdir(dir, { recursive: true });
  const baseline = await experimentBaseline(git, { source, files: await handoffFiles(), scratch: dir });
  const created = newManifest({ id, source, baseline, seedHash: hash, runs: opts.runs ?? DEFAULT_RUNS, now: new Date() });
  await writeJson(path, created);
  return serialStore(path, created);
}

// The token is drawn inside the store's turn, so the two runs of a pair never draw the same one
async function begin(night: Night, ref: RunRef, alone: boolean): Promise<string> {
  const m = await night.store.update((value) => startAttempt(value, ref, newToken(new Set(value.attempts.map((a) => a.token))), new Date(), alone));
  return latest(m, ref)?.token ?? '';
}

// The sandbox file is shared by both runs of a pair; rewritten after each draws its token, in turn, so the last write names every open
// run's plugin copy, which the plugin skills read their conventions from
let sandboxWrites = Promise.resolve();
function allowPlugins(night: Night): Promise<void> {
  const plugins = openAttempts(night.store.get()).map((a) => join(runHome(night.state, a.token), 'plugin'));
  sandboxWrites = sandboxWrites.then(() => installSandbox(night.root, night.sandbox.gitDir, sandboxSettings({ ...night.sandbox, state: night.state, plugins })));
  return sandboxWrites;
}

async function execute(night: Night, ref: RunRef, alone: boolean): Promise<void> {
  const token = await begin(night, ref, alone);
  await allowPlugins(night);
  let outcome: Outcome = 'error';
  try {
    const metrics = await executeRun(
      { dir: night.dir, root: night.root, state: night.state, baseline: night.store.get().baseline, token, arm: ref.arm, seed: night.seed, runJs: RUN_JS, timeoutMs: night.opts.runTimeoutMs, unpaired: alone },
      { run: night.git, now: () => new Date(), sleep, log, boot, stop, client: (home) => createDaemonClient(home) },
    );
    outcome = metrics.outcome;
    log(`${ref.id} (${token}) ended: ${outcome}${metrics.reason ? ` (${metrics.reason})` : ''}`);
  } catch (err) {
    log(`${ref.id} (${token}) failed: ${message(err)}`);
    await recordFailure(night.dir, token, message(err), alone);
    await dropRunWorktrees(night.git, runPrefix(token)).catch(() => undefined);
  }
  await night.store.update((value) => endAttempt(value, token, outcome));
}

async function main(): Promise<void> {
  const opts = parseExperimentArgs(process.argv.slice(2));
  const now = new Date();
  const deadline = opts.until === undefined ? undefined : untilDeadline(now, opts.until);
  const git = serialGit(execRun);
  const root = await repoRoot(git);
  const id = opts.experiment ?? newExperimentId(now);
  const state = stateRoot(process.env, homedir());
  await prepareState(state);
  // Every worker's Bash runs in Claude Code's sandbox: no prompt to stall a night on, no write outside the clone (#105)
  const paths = await sandboxPaths(git);
  await installSandbox(root, paths.gitDir, sandboxSettings({ ...paths, state }));
  await unsignedCommits(git);
  const dir = experimentDir(state, id);
  const seed = await loadSeed(); // fails fast on a missing screen or a word a worker must not read
  const store = await openStore(state, dir, id, opts, git);
  const night: Night = { root, state, dir, store, seed, opts, git, sandbox: paths };
  const tokenOf = (ref: RunRef): string => latest(store.get(), ref)?.token ?? '';
  stopOnInterrupt();
  log(`experiment ${id}: baseline ${store.get().baseline.slice(0, 12)}, ${store.get().runs} pairs${deadline ? `, no new pair after ${deadline.toLocaleString()}` : ''}`);
  const ran = await runLoop(store.get().runs, deadline, {
    now: () => new Date(), log,
    hasMetrics: async (ref) => isMeasured(store.get(), ref),
    hasJudge: async (ref) => existsSync(join(dir, tokenOf(ref), FILES.judge)),
    execute: (ref, alone) => execute(night, ref, alone),
    evaluate: (ref) => evaluateRun({ dir, baseline: store.get().baseline, token: tokenOf(ref), seed, judgeModel: opts.judgeModel }, evalDeps(root, git)),
    report: () => writeReport(dir, store.get()),
  });
  log(`${ran.length} runs this call; report: ${join(dir, FILES.report)}`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(message(err));
  process.exit(1);
}
