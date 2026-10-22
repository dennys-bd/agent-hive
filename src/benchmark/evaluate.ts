// One benchmark run's evaluation (#474, root design "Evaluation"), the harness's evaluate-run.ts order on an eval worktree of the run branch:
// collectors, the dynamic collector, then the blind judge. Every artifact under runs/<token>/eval/; the worktree is removed on every path.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cutPatch, type Work } from '../evaluate-prompt.js';
import type { HeadlessInput, HeadlessResult } from '../headless-run.js';
import { rubricLines } from '../stage-agent.js';
import type { BenchRun, BenchRunEvaluation, CollectorResult, EvaluateRow, Experiment, ScenarioResult } from '../types.js';
import { assertBlind, blindTells, bundleFiles, pluginSubagents, scrub } from './blind.js';
import { type Click, failedWalks, type ReadyDeps, SAMPLE_STOP_GRACE_MS, type SpawnSample, scenarioResults, startSample, stopSample, testerRefusal, waitReady, walkScenarios } from './browser.js';
import { collectorName, runCollectors } from './collectors.js';
import { buildEnv, inDir, type Run } from './exec.js';
import { addWorktree, BASELINE_BRANCH, CLONE_DIR, diffShortstat, fetchBranch, fullDiff, remoteSha, removeWorktree, resolveBaseline } from './git.js';
import { judgeBundle, rubricHash } from './judge.js';
import { pluginTrees } from './pin.js';

const NO_BRANCH = 'the run branch does not exist';
const FILE_MODE = 0o600;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export interface EvaluateContext { experiment: Experiment; run: BenchRun; folder: string } // folder: <home>/benchmark/<id>
export interface EvaluateDeps {
  exec: Run;
  headless(input: HeadlessInput): Promise<HeadlessResult>;
  browser: { ensureChromium(): Promise<{ path: string } | { reason: string }>; mcpBinary(): Promise<string> };
  spawnSample: SpawnSample;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  fetch: ReadyDeps['fetch'];
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  signal: AbortSignal;
  tmpRoot: string;
}
export interface EvalPaths { dir: string; worktree: string; screens: string; clicks: string; bundle: string; judge: string }

export const evalPaths = (home: string): EvalPaths => {
  const dir = join(home, 'eval');
  return { dir, worktree: join(dir, 'worktree'), screens: join(dir, 'screens'), clicks: join(dir, 'clicks.json'), bundle: join(dir, 'bundle'), judge: join(dir, 'judge.json') };
};

interface Parts { work: Work; collectors: CollectorResult[]; scenarios: ScenarioResult[]; walks: Click[][] }

function tasksText(ctx: EvaluateContext): string {
  const arm = ctx.experiment.arms.find((a) => a.id === ctx.run.armId);
  return (arm?.overrides.tasks ?? ctx.experiment.base.tasks).map((t) => `${t.title}\n\n${t.body}`).join('\n\n');
}

const judgeRecord = (row: EvaluateRow, rubric: string, scores: BenchRunEvaluation['judge']['scores']): BenchRunEvaluation['judge'] =>
  ({ agent: row.agent, ...(row.model === undefined ? {} : { model: row.model }), rubricHash: rubricHash(rubric), scores });

const walksOf = (ctx: EvaluateContext): number => ctx.experiment.evaluation.scenarioWalks;
const scenariosOf = (ctx: EvaluateContext) => (ctx.experiment.evaluation.dynamic ? ctx.experiment.seed.scenarios : []);

async function noBranch(ctx: EvaluateContext, paths: EvalPaths, at: string): Promise<BenchRunEvaluation> {
  const { evaluation } = ctx.experiment;
  const evaluated: BenchRunEvaluation = {
    at,
    collectors: evaluation.collectors.map((row) => ({ name: collectorName(row), status: 'error', summary: NO_BRANCH, findings: [] })),
    scenarios: scenariosOf(ctx).map((s) => ({ id: s.id, passed: 0, total: walksOf(ctx), screenshots: [] })),
    judge: judgeRecord(evaluation.judge, evaluation.rubric, rubricLines(evaluation.rubric).map((dimension) => ({ dimension, score: 1, evidence: NO_BRANCH }))),
  };
  await writeFile(paths.judge, json(evaluated.judge), { mode: FILE_MODE });
  return evaluated;
}

async function clean(paths: EvalPaths, git: Run): Promise<void> {
  await removeWorktree(git, paths.worktree).catch(() => undefined);
  await Promise.all([paths.worktree, paths.screens, paths.clicks, paths.bundle, paths.judge].map((p) => rm(p, { recursive: true, force: true })));
  await mkdir(paths.screens, { recursive: true });
}

// A sample that never answers must not leave the walks unanswered: every walk records why it could not run
async function walkSample(ctx: EvaluateContext, paths: EvalPaths, chromiumPath: string, deps: EvaluateDeps): Promise<Click[][]> {
  const { experiment } = ctx;
  const { sample } = experiment.seed;
  const fill = (reason: string, line: string): Click[][] => {
    deps.log(line);
    return failedWalks(experiment.seed.scenarios, walksOf(ctx), reason);
  };
  const child = startSample(sample.command, paths.worktree, deps.spawnSample, buildEnv(process.env));
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; deps.log('sample: spawn failed'); }); // a failed spawn emits error and never exit
  try {
    const unready = await waitReady(sample.url, { fetch: deps.fetch, now: deps.now, sleep: deps.sleep, exited: () => exited });
    if (unready !== undefined) return fill(unready, 'scenarios: the sample did not start');
    const mcpBin = await deps.browser.mcpBinary();
    const input = { tester: experiment.evaluation.tester, scenarios: experiment.seed.scenarios, walks: walksOf(ctx), url: sample.url, screens: paths.screens, chromiumPath, mcpBin };
    return await walkScenarios(input, { headless: deps.headless, log: deps.log, signal: deps.signal, tmpRoot: deps.tmpRoot });
  } finally {
    await stopSample(child, { kill: deps.kill, graceMs: SAMPLE_STOP_GRACE_MS });
  }
}

async function dynamicStep(ctx: EvaluateContext, paths: EvalPaths, deps: EvaluateDeps): Promise<Click[][]> {
  const { scenarios } = ctx.experiment.seed;
  if (scenarios.length === 0) return [];
  const refusal = testerRefusal(ctx.experiment.evaluation.tester.agent);
  if (refusal !== undefined) {
    deps.log(`scenarios: ${ctx.experiment.evaluation.tester.agent} cannot run the tester`);
    return failedWalks(scenarios, walksOf(ctx), refusal);
  }
  const chromium = await deps.browser.ensureChromium();
  if ('reason' in chromium) {
    deps.log('scenarios: Chromium is not installed');
    return failedWalks(scenarios, walksOf(ctx), chromium.reason);
  }
  return walkSample(ctx, paths, chromium.path, deps);
}

async function judgeStep(ctx: EvaluateContext, paths: EvalPaths, parts: Parts, deps: EvaluateDeps): Promise<BenchRunEvaluation['judge'] | undefined> {
  const { evaluation } = ctx.experiment;
  const pluginDir = pluginTrees(ctx.folder).source;
  const tells = blindTells(ctx.experiment, await pluginSubagents(pluginDir));
  const files = bundleFiles({ patch: parts.work.patch, ...(ctx.run.metrics === undefined ? {} : { metrics: ctx.run.metrics }), collectors: parts.collectors, scenarios: scenariosOf(ctx), results: parts.scenarios, walks: parts.walks, screens: paths.screens }, tells);
  const work: Work = { ...parts.work, id: 'run', body: scrub(parts.work.body, tells), stat: scrub(parts.work.stat, tells), patch: scrub(parts.work.patch, tells) };
  const findings = parts.collectors.map((c, i) => ({ who: `collector-${i + 1}`, findings: c.findings.map((f) => ({ ...f, file: scrub(f.file, tells), finding: scrub(f.finding, tells) })) }));
  // a refusal is a bug in scrub, not a run to judge: it throws and the service logs the evaluation as failed
  assertBlind([...files, { name: 'task', text: work.body }, { name: 'stat', text: work.stat }, { name: 'findings', text: JSON.stringify(findings) }], tells, ctx.experiment.arms.map((a) => a.letter));
  const judged = await judgeBundle({ row: evaluation.judge, pluginDir, rubric: evaluation.rubric, files, work, findings }, paths.bundle, { headless: deps.headless, signal: deps.signal, tmpRoot: deps.tmpRoot });
  if ('reason' in judged) {
    deps.log('judge: error');
    return undefined;
  }
  return judgeRecord(evaluation.judge, evaluation.rubric, judged.scores);
}

async function evaluateWorktree(ctx: EvaluateContext, paths: EvalPaths, git: Run, at: string, deps: EvaluateDeps): Promise<BenchRunEvaluation | undefined> {
  const { evaluation } = ctx.experiment;
  const { branch } = ctx.run;
  // The run branch was cut from the clone's origin/main (createRunBranches): that is the baseline the diff is against
  const baseline = await resolveBaseline(git, `origin/${BASELINE_BRANCH}`);
  const work: Work = { id: ctx.run.token, title: 'The tasks of the run', body: tasksText(ctx), base: 'the baseline', stat: await diffShortstat(git, baseline, branch), patch: cutPatch(await fullDiff(git, baseline, branch)) };
  deps.signal.throwIfAborted();
  const collectors = await runCollectors(evaluation.collectors, work, paths.worktree, pluginTrees(ctx.folder).source, { headless: deps.headless, signal: deps.signal, log: deps.log });
  deps.signal.throwIfAborted();
  const walks = evaluation.dynamic ? await dynamicStep(ctx, paths, deps) : [];
  await writeFile(paths.clicks, json(walks), { mode: FILE_MODE });
  deps.signal.throwIfAborted();
  const scenarios = scenarioResults(scenariosOf(ctx), walks);
  const judge = await judgeStep(ctx, paths, { work, collectors, scenarios, walks }, deps);
  if (judge === undefined) return undefined;
  await writeFile(paths.judge, json(judge), { mode: FILE_MODE });
  return { at, collectors, scenarios, judge };
}

/** undefined: the judge failed, and the run keeps the evaluation it had. */
export async function evaluateRun(ctx: EvaluateContext, deps: EvaluateDeps): Promise<BenchRunEvaluation | undefined> {
  deps.signal.throwIfAborted();
  const paths = evalPaths(ctx.run.home);
  const git = inDir(deps.exec, join(ctx.folder, CLONE_DIR));
  const at = new Date(deps.now()).toISOString();
  await clean(paths, git);
  if ((await remoteSha(git, ctx.run.branch)) === undefined) return noBranch(ctx, paths, at);
  await fetchBranch(git, ctx.run.branch);
  await addWorktree(git, paths.worktree, `origin/${ctx.run.branch}`);
  try {
    return await evaluateWorktree(ctx, paths, git, at, deps);
  } finally {
    await removeWorktree(git, paths.worktree).catch(() => deps.log('worktree: not removed'));
  }
}
