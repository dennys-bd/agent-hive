// The benchmark PR routes (#477): the preview the dialog's commits line reads, and the PR itself, rebased and pushed from a temporary worktree or
// the workspace's checkout as its benchmarkPrIn says. Mounted from server-benchmark.ts (1.2), the only benchmark route file server.ts mounts.
// A refusal the dialog shows answers 409 with a BenchPrRefusal; a git or gh failure 502 with its step; the rest { error } as refuse does.
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { experimentDir } from './benchmark-guards.js';
import { inDir, type Run } from './benchmark/exec.js';
import { isPlainRef, ORIGIN_DIR } from './benchmark/git.js';
import { errorClass, type FetchedRun, fetchRun, openPr, PrStepError, prBody } from './benchmark/pr.js';
import { type BenchPrPreview, type BenchPrRefusal, type BenchPrStep, isEnded, prTitle, suggestBranch } from './benchmark/pr-pick.js';
import { aggregate } from './benchmark/report.js';
import { workspaceByName } from './config.js';
import type { Logger } from './log.js';
import { isJsonObject } from './state-guards.js';
import { BENCH_TOKEN, type BenchRun, type Config, EXPERIMENT_ID, type Experiment, type State, type Workspace } from './types.js';
import { remoteHead } from './worktree-base.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_INTERNAL = 500;
const PATH = '/benchmark/experiments/:id/runs/:token/pr';
const ORIGIN = 'origin';
const NO_EXPERIMENT = 'no such experiment';
const NO_RUN = 'no such run in this experiment';
const NO_WORKSPACE = 'no such workspace';
const BODY_MESSAGE = 'the body must be { branch: string, withSummary: boolean }';
const BRANCH_MESSAGE = 'branch must be a plain branch name';

/** What the PR routes need (#477): the state and the config, the Hive's home the experiment folders live under, git and gh, the clock and the log. */
export interface BenchmarkPrDeps {
  getState(): State | undefined; // undefined before the Hive is live: no experiment to answer
  getConfig(): Config | undefined; // the workspace's path, base branch and benchmarkPrIn, which State does not hold
  hiveDir: string;
  exec: Run; // git, argv only
  gh: Run; // gh pr create, argv only
  now(): number;
  log: Logger;
}

interface Target { experiment: Experiment; run: BenchRun; workspace: Workspace; config: Config }
interface PrRequest { branch: string; withSummary: boolean }

const refuse = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error });
};
const refusal = (res: Response, answer: BenchPrRefusal): void => {
  res.status(HTTP_CONFLICT).json(answer);
};

// The id and the token are checked before any lookup, so neither reaches a path or git's argv unchecked; the run's repository is the seed's workspace
function targetOf(deps: BenchmarkPrDeps, req: Request, res: Response): Target | undefined {
  const id = req.params.id as string;
  const token = req.params.token as string;
  const experiment = EXPERIMENT_ID.test(id) ? deps.getState()?.benchmark.experiments.find((e) => e.id === id) : undefined;
  if (experiment === undefined) return void refuse(res, HTTP_NOT_FOUND, NO_EXPERIMENT);
  const run = BENCH_TOKEN.test(token) ? experiment.rounds.flatMap((r) => r.runs).find((r) => r.token === token) : undefined;
  if (run === undefined) return void refuse(res, HTTP_NOT_FOUND, NO_RUN);
  const config = deps.getConfig();
  const workspace = config === undefined ? undefined : workspaceByName(config, experiment.seed.workspace);
  if (config === undefined || workspace === undefined) return void refuse(res, HTTP_NOT_FOUND, NO_WORKSPACE);
  if (!isEnded(run)) return void refusal(res, { error: 'not-ended' });
  return { experiment, run, workspace, config };
}

// { branch, withSummary } and nothing else
function prRequestOf(body: unknown): PrRequest | undefined {
  if (!isJsonObject(body) || Object.keys(body).length !== 2 || typeof body.branch !== 'string' || typeof body.withSummary !== 'boolean') return undefined;
  return { branch: body.branch, withSummary: body.withSummary };
}

// isPlainRef keeps an option or revision syntax off git's argv; git's own check then refuses what only it knows (a .lock suffix, a trailing dot)
async function isBranch(git: Run, branch: string): Promise<boolean> {
  if (!isPlainRef(branch)) return false;
  return git('git', ['check-ref-format', '--branch', branch]).then(() => true, () => false);
}

// The workspace's own base over the config's; with neither, origin's HEAD, else main, as a worker's worktree starts (#119, #854). The PR goes
// where gh points from origin: a fork's upstream is out of #477
async function baseOf(git: Run, { workspace, config }: Target): Promise<string> {
  const branch = workspace.baseBranch ?? config.baseBranch;
  return branch ?? remoteHead(async (...args) => (await git('git', args)).stdout, ORIGIN);
}

const repoGitOf = (deps: BenchmarkPrDeps, experiment: Experiment): string => join(experimentDir(deps.hiveDir, experiment.id), ORIGIN_DIR);

function previewOf({ experiment, run, workspace }: Target, base: string, fetched: FetchedRun): BenchPrPreview {
  return {
    token: run.token, armId: run.armId, status: run.status, commits: fetched.commits, tasks: run.total,
    base: `${ORIGIN}/${base}`, baseSha: fetched.baseSha, branch: suggestBranch(experiment.name), title: prTitle(experiment.name), via: workspace.benchmarkPrIn,
  };
}

// The step and the class only: git's and gh's words carry paths under the user's home and the remote's account
function failed(deps: BenchmarkPrDeps, res: Response, experiment: Experiment, step: BenchPrStep, cause: unknown): void {
  deps.log.error(`benchmark PR of experiment ${experiment.id} failed at ${step}: ${errorClass(cause)}`);
  res.status(HTTP_BAD_GATEWAY).json({ error: step });
}

// Anything that is not a PrStepError: the class only, and a fixed answer, since Express's own handler can echo git's stderr and home paths
async function guarded(deps: BenchmarkPrDeps, res: Response, experiment: Experiment, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    deps.log.error(`benchmark PR of experiment ${experiment.id} failed: ${errorClass(err)}`);
    if (!res.headersSent) res.status(HTTP_INTERNAL).json({ error: 'internal' });
  }
}

async function answerPreview(deps: BenchmarkPrDeps, target: Target, res: Response): Promise<void> {
  const git = inDir(deps.exec, target.workspace.path);
  try {
    const base = await baseOf(git, target);
    res.json(previewOf(target, base, await fetchRun(git, repoGitOf(deps, target.experiment), target.run.token, base)));
  } catch (err) {
    failed(deps, res, target.experiment, 'fetch', err);
  }
}

async function at<T>(step: BenchPrStep, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new PrStepError(step, err);
  }
}

async function answerPr(deps: BenchmarkPrDeps, target: Target, request: PrRequest, res: Response): Promise<void> {
  const { experiment, run, workspace } = target;
  try {
    const base = await at('fetch', () => baseOf(inDir(deps.exec, workspace.path), target));
    const report = request.withSummary ? aggregate(experiment, 'in', deps.now()) : undefined;
    const answer = await openPr({ exec: deps.exec, gh: deps.gh, log: deps.log }, {
      experimentId: experiment.id, token: run.token, workspace, repoGit: repoGitOf(deps, experiment), base,
      branch: request.branch, title: prTitle(experiment.name), body: prBody(experiment, run, report),
    });
    if ('error' in answer) return refusal(res, answer);
    res.json(answer);
  } catch (err) {
    if (!(err instanceof PrStepError)) throw err;
    failed(deps, res, experiment, err.step, err.cause);
  }
}

/** GET …/runs/:token/pr (the preview) and POST …/runs/:token/pr ({ branch, withSummary }) (#477). */
export function registerBenchmarkPrRoutes(app: Express, deps: BenchmarkPrDeps): void {
  const busy = new Set<string>(); // workspaces with a sequence running: two on one checkout or one ref would race
  app.get(PATH, async (req: Request, res: Response) => {
    const target = targetOf(deps, req, res);
    if (target === undefined) return;
    if (busy.has(target.workspace.name)) return refusal(res, { error: 'busy' });
    await guarded(deps, res, target.experiment, () => answerPreview(deps, target, res));
  });
  app.post(PATH, async (req: Request, res: Response) => {
    const target = targetOf(deps, req, res);
    if (target === undefined) return;
    const request = prRequestOf(req.body);
    if (request === undefined) return refuse(res, HTTP_BAD_REQUEST, BODY_MESSAGE);
    if (!(await isBranch(inDir(deps.exec, target.workspace.path), request.branch))) return refuse(res, HTTP_BAD_REQUEST, BRANCH_MESSAGE);
    const name = target.workspace.name;
    if (busy.has(name)) return refusal(res, { error: 'busy' });
    busy.add(name);
    try {
      await guarded(deps, res, target.experiment, () => answerPr(deps, target, request, res));
    } finally {
      busy.delete(name);
    }
  });
}
