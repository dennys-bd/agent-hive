import { copyFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { DaemonAddress } from '../../src/daemon.js';
import { evalConfig } from './harness-config.js';
import { assertBlind, bundleFiles, writeBundle } from './blind.js';
import { type Cookie, dashboardCookie, type Launch, MCP_BIN, mcpConfig, smokeDashboard, storageState } from './browser.js';
import { extractJson, JUDGE_TIMEOUT_MS, judgeArgs, parseClicks, parseJudge, runClaude, TESTER_TIMEOUT_MS, testerArgs } from './claude.js';
import type { RunningDaemon } from '../../src/benchmark/daemon.js';
import { buildEnv, type Run } from '../../src/benchmark/exec.js';
import { pngsIn, readJson, writeJson } from './files.js';
import { addWorktree, fetchBranch, fullDiff, remoteSha, removeWorktree } from '../../src/benchmark/git.js';
import { runDocs } from './docs-git.js';
import { runBranch, runPrefix } from './plan.js';
import { judgePrompt, testerPrompt } from './prompts.js';
import { writeHome } from './run-home.js';
import { materializeSample, type Seed } from './seed.js';
import { type Click, CRITERIA, type Criterion, FILES, type Metrics, type Score } from './types.js';

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 30 * 60_000;
const RUN_JS = join('dist', 'src', 'run.js'); // the run branch's own daemon
// The Playwright MCP's socket folder: /tmp keeps its path under macOS's socket limit, where the per-user TMPDIR does not
const SOCKETS_PREFIX = '/tmp/hive-pw-';
const DASHBOARD_SHOT = 'dashboard.png';

export interface EvalContext { dir: string; baseline: string; docsBaseline: string; token: string; seed: Seed; judgeModel: string }
export interface EvalDeps {
  run: Run; docs: Run; launch: Launch; log(line: string): void; boot(home: string, runJs: string): Promise<RunningDaemon>; stop(daemon: RunningDaemon): Promise<void>;
  repoRoot: string; chromiumPath: string; tmpRoot: string; // the OS temp dir: the reviewers' folders sit away from the experiment and its manifest
}
interface Paths { worktree: string; home: string; screens: string; metrics: string; evaluation: string; clicks: string; judge: string; bundle: string }
interface Ui { booted: boolean; reason?: string }

function pathsOf(ctx: EvalContext): Paths {
  const base = join(ctx.dir, ctx.token);
  return {
    worktree: join(base, 'eval'), home: join(base, 'eval-home'), screens: join(base, FILES.screens), metrics: join(base, FILES.metrics),
    evaluation: join(base, FILES.evaluation), clicks: join(base, FILES.clicks), judge: join(base, FILES.judge), bundle: join(base, FILES.bundle),
  };
}

const reasonOf = (prefix: string, err: unknown): string => `${prefix}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`;

// @playwright/mcp writes a screenshot the tester names into its workspace root, the review folder, and only an unnamed one
// under --output-dir: every PNG in the folder is kept, one in a subfolder named by its path (screens/x.png is screens-x.png)
async function keepShots(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const shots = (await readdir(from, { recursive: true })).filter((name) => name.endsWith('.png')).sort();
  for (const shot of shots) await copyFile(join(from, shot), join(to, shot.split(sep).join('-')));
}

// Its own checkout, installed and built; its pnpm test is the green / red the report trusts
async function buildCheckout(paths: Paths, branch: string, deps: EvalDeps): Promise<{ testsGreen: boolean; reason?: string }> {
  await removeWorktree(deps.run, paths.worktree).catch(() => undefined); // left by a stopped evaluation
  await addWorktree(deps.run, paths.worktree, `origin/${branch}`);
  const cwd = paths.worktree;
  const env = buildEnv(process.env);
  try {
    await deps.run('pnpm', ['install', '--frozen-lockfile'], { cwd, env, timeoutMs: INSTALL_TIMEOUT_MS });
    await deps.run('pnpm', ['build'], { cwd, env, timeoutMs: BUILD_TIMEOUT_MS });
  } catch (err) {
    return { testsGreen: false, reason: reasonOf('build failed', err) };
  }
  return { testsGreen: await deps.run('pnpm', ['test'], { cwd, env, timeoutMs: TEST_TIMEOUT_MS }).then(() => true, () => false) };
}

// A bare temp folder (0700): the cookie file, the MCP config and the shots, nothing that names the run's arm or the experiment
async function runTester(ctx: EvalContext, paths: Paths, url: string, cookie: Cookie, deps: EvalDeps): Promise<void> {
  const review = await mkdtemp(join(deps.tmpRoot, 'review-'));
  const sockets = await mkdtemp(SOCKETS_PREFIX); // short on purpose: see mcpConfig
  const storage = join(review, 'storage-state.json');
  const config = join(review, 'mcp.json');
  const shots = join(review, 'screens');
  let answer: unknown = [];
  try {
    await mkdir(shots);
    await writeFile(storage, JSON.stringify(storageState(cookie)), { mode: 0o600 });
    await writeFile(config, JSON.stringify(mcpConfig(join(deps.repoRoot, MCP_BIN), storage, shots, new URL(url).origin, deps.chromiumPath, sockets)), { mode: 0o600 });
    const prompt = testerPrompt({ url, handoff: ctx.seed.handoff, scenarios: ctx.seed.scenarios, artboards: ctx.seed.artboards });
    answer = extractJson(await runClaude(deps.run, testerArgs(prompt, config), review, TESTER_TIMEOUT_MS), '[');
  } catch (err) {
    deps.log(reasonOf(`${ctx.token}: the tester failed, every scenario counts as failed`, err));
  } finally {
    try {
      await keepShots(review, paths.screens);
    } finally {
      await rm(review, { recursive: true, force: true }); // takes the one copy of the secret outside its home with it, even when keeping the shots fails
      await rm(sockets, { recursive: true, force: true });
    }
  }
  await writeJson(paths.clicks, parseClicks(answer, ctx.seed.scenarios));
}

async function clickThrough(ctx: EvalContext, paths: Paths, address: DaemonAddress, deps: EvalDeps): Promise<Ui> {
  const url = `http://127.0.0.1:${address.port}/`;
  const cookie = dashboardCookie(address.port, address.secret);
  await mkdir(paths.screens, { recursive: true });
  const failed = await smokeDashboard(deps.launch, url, cookie, join(paths.screens, DASHBOARD_SHOT)).then(() => undefined, (err: unknown) => reasonOf('the dashboard did not load', err));
  if (failed) return { booted: false, reason: failed };
  await runTester(ctx, paths, url, cookie, deps);
  return { booted: true };
}

// Sample worktrees, eval home, the run branch's daemon and the clicks; all of it gone when it returns
async function testUi(ctx: EvalContext, paths: Paths, deps: EvalDeps): Promise<Ui> {
  const { state, worktrees } = materializeSample(ctx.seed.sampleState, paths.worktree);
  try {
    for (const path of worktrees) await addWorktree(deps.run, path, 'HEAD', paths.worktree);
    await writeHome(paths.home, evalConfig(ctx.seed.stages, paths.worktree), state);
    const daemon = await deps.boot(paths.home, join(paths.worktree, RUN_JS)).catch((err: unknown) => reasonOf('boot failed', err));
    if (typeof daemon === 'string') return { booted: false, reason: daemon };
    try {
      return await clickThrough(ctx, paths, daemon.address, deps);
    } finally {
      await deps.stop(daemon);
    }
  } finally {
    for (const path of worktrees) await removeWorktree(deps.run, path, paths.worktree).catch(() => undefined);
  }
}

// The judge reads a scrubbed bundle named by the token, in a bare temp folder; the bundle is kept for the record
async function judgeRun(ctx: EvalContext, paths: Paths, booted: boolean, deps: EvalDeps): Promise<void> {
  const metrics = await readJson<Metrics>(paths.metrics);
  if (!metrics) throw new Error(`${ctx.token}: no ${FILES.metrics} to judge`);
  const branch = runBranch(ctx.token);
  const docs = await runDocs(deps.docs, ctx.docsBaseline, runPrefix(ctx.token));
  // Only committed docs are read: a spec left uncommitted went with its worktree, and the judge would not know it is missing
  if (docs.length === 0) deps.log(`${ctx.token}: no spec or plan committed on its docs branches`);
  const files = bundleFiles({
    handoffShots: ctx.seed.screens, runShots: booted ? await pngsIn(paths.screens, (name) => name !== DASHBOARD_SHOT) : [],
    clicks: booted ? await readJson<Click[]>(paths.clicks) : undefined, docs, diff: await fullDiff(deps.run, ctx.baseline, branch), metrics,
  });
  assertBlind(files);
  const review = await mkdtemp(join(deps.tmpRoot, 'review-'));
  const bundle = join(review, ctx.token);
  try {
    await writeBundle(bundle, files);
    const answer = await runClaude(deps.run, judgeArgs(judgePrompt({ booted }), ctx.judgeModel), bundle, JUDGE_TIMEOUT_MS);
    await writeJson(paths.judge, parseJudge(extractJson(answer, '{'), ctx.judgeModel, booted));
    await rm(paths.bundle, { recursive: true, force: true });
    await cp(bundle, paths.bundle, { recursive: true });
  } finally {
    await rm(review, { recursive: true, force: true });
  }
}

// A run that failed before its branch was pushed has nothing to evaluate: record that once, so a resume does not retry it
async function recordNoBranch(ctx: EvalContext, paths: Paths, branch: string): Promise<void> {
  const reason = `the run branch ${branch} does not exist on origin`;
  await writeJson(paths.evaluation, { booted: false, testsGreen: false, reason });
  const scores = Object.fromEntries(CRITERIA.map((c) => [c, { score: null, reason }])) as Record<Criterion, Score>;
  await writeJson(paths.judge, { model: ctx.judgeModel, scores });
}

/** One run's evaluation, also run alone by experiment:evaluate. A branch that does not build or boot gets no clicks and is still judged. */
export async function evaluateRun(ctx: EvalContext, deps: EvalDeps): Promise<void> {
  const paths = pathsOf(ctx);
  const branch = runBranch(ctx.token);
  await Promise.all([rm(paths.screens, { recursive: true, force: true }), rm(paths.clicks, { force: true }), rm(paths.bundle, { recursive: true, force: true })]); // a re-evaluation starts clean
  if ((await remoteSha(deps.run, branch)) === undefined) return recordNoBranch(ctx, paths, branch);
  await fetchBranch(deps.run, branch);
  try {
    const built = await buildCheckout(paths, branch, deps);
    const ui = built.reason === undefined ? await testUi(ctx, paths, deps) : { booted: false, reason: built.reason };
    await writeJson(paths.evaluation, { booted: ui.booted, testsGreen: built.testsGreen, ...(ui.reason === undefined ? {} : { reason: ui.reason }) });
    await judgeRun(ctx, paths, ui.booted, deps);
  } finally {
    await removeWorktree(deps.run, paths.worktree).catch((err: unknown) => deps.log(reasonOf(`could not remove ${paths.worktree}`, err)));
  }
}
