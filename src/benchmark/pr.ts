// A benchmark run's PR (#477): the run branch fetched from the run's origin, rebased onto the workspace's base in a temporary worktree or the
// workspace's checkout, stripped of the run's own files, pushed and opened with gh. Every command is an argv through the injected runners;
// prBody is pure. The route (server-benchmark-pr.ts) checks the request; this module answers a refusal, a URL, or a PrStepError naming its step.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../log.js';
import type { BenchRun, Experiment, Workspace } from '../types.js';
import { worktreePath } from '../worktree.js';
import { mergeArm } from './arm-config.js';
import { inDir, type Run } from './exec.js';
import { EXPERIMENT_PATHS, remoteSha, removeWorktree, runBranch } from './git.js';
import type { BenchPrAnswer, BenchPrRefusal, BenchPrStep } from './pr-pick.js';
import { duration, HASH_SHOWN, millions, plain, usd } from './report-md.js';
import type { BenchReport, SpreadCell } from './report.js';

export type { BenchPrAnswer, BenchPrPreview, BenchPrRefusal, BenchPrStep } from './pr-pick.js';

const BODY_LINE = 'Opened from a benchmark run.';
const NO_VALUE = '-';

const median = (cell: SpreadCell | undefined, format: (value: number) => string): string =>
  (cell?.value === undefined ? NO_VALUE : format(cell.value.median));
const hashes = (e: Experiment): string =>
  [`seed ${e.seedHash.slice(0, HASH_SHOWN)}`, `tasks ${e.tasksHash.slice(0, HASH_SHOWN)}`, `plugin ${e.plugin.hash.slice(0, HASH_SHOWN)}`].join(' · ');

// The arm's column of the report, in report.md's formats; no link, since the Hive has no URL for an experiment
function summaryLines(experiment: Experiment, run: BenchRun, report: BenchReport): string[] {
  const arm = experiment.arms.find((a) => a.id === run.armId);
  const x = report.execution;
  const tests = x.tests.cells[run.armId];
  return [
    `Experiment ${experiment.name}, arm ${arm?.letter ?? NO_VALUE} · ${arm?.name ?? NO_VALUE}, run ${run.token}, round ${run.round}.`, '',
    `- tokens: ${median(x.tokens.cells[run.armId], millions)}`, `- cost: ${median(x.cost.cells[run.armId], usd)}`,
    `- time: ${median(x.time.cells[run.armId], duration)}`, `- tests green: ${tests === undefined ? NO_VALUE : `${tests.passed}/${tests.total}`}`,
    ...report.judgeRows.map((row) => `- ${row.key}: ${median(row.cells[run.armId], plain)}`), '', hashes(experiment),
  ];
}

/** The PR's description, in English (#477): with the report, the run and its arm's column of it; without, the run's task titles. */
export function prBody(experiment: Experiment, run: BenchRun, report: BenchReport | undefined): string {
  if (report !== undefined) return [BODY_LINE, '', ...summaryLines(experiment, run, report), ''].join('\n');
  const arm = experiment.arms.find((a) => a.id === run.armId);
  const tasks = arm === undefined ? experiment.base.tasks : mergeArm(experiment.base, arm.overrides).tasks;
  return [BODY_LINE, '', ...tasks.map((task) => `- ${task.title}`), ''].join('\n');
}

/** What a PR must not carry (#477): the sandbox's settings and the harness, which the baseline left out and a run may have added. */
export const RUN_FILES = ['.claude/settings.local.json', ...EXPERIMENT_PATHS] as const;
const DROP_MESSAGE = 'chore: drop run files';
const WORKTREE_PREFIX = 'bench-pr-';
const PR_URL = /^https:\/\/\S+\/pull\/\d+$/;

/** Where the fetched run branch lives (#477): a namespace no branch listing shows. */
export const benchRef = (token: string): string => `refs/hive/bench/${token}`;
/** What a log line may say of a failure (#477): its class, never git's or gh's words, which carry paths under the user's home. */
export const errorClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
// The run's commits are untrusted worker output: no hook of the repo may fire on a step that could run one (the user's own hooks do not run here)
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const hookless = (...args: string[]): string[] => [...NO_HOOKS, ...args];
const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

export interface FetchedRun { baseline: string; commits: number; baseSha: string }

/** The run branch into refs/hive/bench/<token>, forced so the preview and its PR read the same commits, and origin's base; then the orphan
 *  baseline the run started from, the run's own commits after it, and the base's short sha. */
export async function fetchRun(git: Run, repoGit: string, token: string, base: string): Promise<FetchedRun> {
  const ref = benchRef(token);
  await git('git', ['-c', 'transfer.fsckObjects=true', 'fetch', repoGit, `+refs/heads/${runBranch(token)}:${ref}`]);
  await git('git', ['fetch', 'origin', base]);
  const baseline = lines((await git('git', ['rev-list', '--max-parents=0', ref])).stdout).at(0);
  if (baseline === undefined) throw new Error('the run branch has no root commit');
  const commits = Number((await git('git', ['rev-list', '--count', `${baseline}..${ref}`])).stdout.trim());
  const baseSha = (await git('git', ['rev-parse', '--short', `origin/${base}`])).stdout.trim();
  return { baseline, commits, baseSha };
}

/** The run's own commits (<baseline>..<branch>, the baseline having no parent) replayed onto origin/<base>. A conflict is aborted and answers
 *  its files; any other failure is thrown after the abort. */
export async function rebaseRun(git: Run, branch: string, baseline: string, base: string): Promise<{ files: string[] } | undefined> {
  try {
    await git('git', hookless('rebase', '--onto', `origin/${base}`, baseline, branch));
    return undefined;
  } catch (err) {
    const files = await git('git', ['diff', '--name-only', '--diff-filter=U']).then((r) => lines(r.stdout), () => []);
    await git('git', hookless('rebase', '--abort')).catch(() => undefined); // the rebase's own error is the one to report
    if (files.length === 0) throw err;
    return { files };
  }
}

/** One `chore: drop run files` commit when a run file differs from origin/<base>: each restored to the base's version, or removed when the
 *  base lacks it. The run's own commits stay as they are. */
export async function dropRunFiles(git: Run, base: string): Promise<boolean> {
  const files = lines((await git('git', ['diff', '--name-only', `origin/${base}`, 'HEAD', '--', ...RUN_FILES])).stdout);
  if (files.length === 0) return false;
  const inBase = await Promise.all(files.map((file) => git('git', ['cat-file', '-e', `origin/${base}:${file}`]).then(() => true, () => false)));
  const restored = files.filter((_, i) => inBase[i]);
  const removed = files.filter((_, i) => !inBase[i]);
  if (restored.length > 0) await git('git', ['restore', '--source', `origin/${base}`, '--staged', '--worktree', '--', ...restored]);
  if (removed.length > 0) await git('git', ['rm', '-q', '--', ...removed]);
  await git('git', hookless('commit', '-q', '--no-verify', '-m', DROP_MESSAGE));
  return true;
}

export interface PrDeps { exec: Run; gh: Run; log: Logger }
export interface PrInput {
  experimentId: string; token: string; workspace: Pick<Workspace, 'path' | 'benchmarkPrIn'>; repoGit: string;
  base: string; branch: string; title: string; body: string; // base: the base branch's name, without origin/
}

/** A git or gh step that failed (#477): the route answers 502 with the step; the cause stays out of the answer and the log. */
export class PrStepError extends Error {
  readonly step: BenchPrStep;
  constructor(step: BenchPrStep, cause: unknown) {
    super(`benchmark PR failed at ${step}`, { cause });
    this.step = step;
  }
}

async function at<T>(step: BenchPrStep, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof PrStepError ? err : new PrStepError(step, err);
  }
}

interface Place { dir: string; leave(pushed: boolean): Promise<void> }

async function enterWorktree(git: Run, input: PrInput): Promise<Place> {
  const path = worktreePath(input.workspace.path, `${WORKTREE_PREFIX}${input.token}`);
  await at('branch', () => git('git', hookless('worktree', 'add', '-b', input.branch, path, benchRef(input.token))));
  return {
    dir: path,
    leave: async (pushed) => {
      try {
        await removeWorktree(git, path);
      } finally {
        if (!pushed) await git('git', ['branch', '-D', input.branch]);
      }
    },
  };
}

// git status --porcelain: two status columns and a space, then the path, or `old -> new` for a rename. Not trimmed: the columns carry spaces
const porcelainFiles = (text: string): string[] =>
  text.split('\n').filter((l) => l.trim() !== '').map((l) => l.slice(3).split(' -> ').at(-1) ?? '');

// A detached checkout goes back to its commit: symbolic-ref exits 1 there
async function currentRef(git: Run): Promise<string> {
  try {
    return (await git('git', ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  } catch (err) {
    if ((err as { code?: unknown }).code !== 1) throw err;
    return (await git('git', ['rev-parse', 'HEAD'])).stdout.trim();
  }
}

async function enterCheckout(git: Run, input: PrInput): Promise<Place | BenchPrRefusal> {
  const files = porcelainFiles((await at('branch', () => git('git', ['status', '--porcelain']))).stdout);
  if (files.length > 0) return { error: 'dirty', files };
  const previous = await at('branch', () => currentRef(git));
  await at('branch', () => git('git', hookless('checkout', '-b', input.branch, benchRef(input.token))));
  return {
    dir: input.workspace.path,
    leave: async (pushed) => {
      try {
        // A step that failed midway (the drop commit) leaves staged changes; enterCheckout required a clean tree, so nothing of the user's is lost
        await git('git', hookless('reset', '--hard', 'HEAD'));
        await git('git', hookless('checkout', previous));
      } finally {
        if (!pushed) await git('git', ['branch', '-D', input.branch]);
      }
    },
  };
}

// The body through a file, never an argv value; the folder goes whatever gh answers
async function createPr(gh: Run, input: PrInput): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hive-bench-pr-'));
  try {
    const file = join(dir, 'body.md');
    await writeFile(file, input.body);
    const out = (await gh('gh', ['pr', 'create', '--base', input.base, '--head', input.branch, '--title', input.title, '--body-file', file])).stdout;
    const url = lines(out).at(-1) ?? '';
    if (!PR_URL.test(url)) throw new Error('gh pr create answered no PR URL');
    return url;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// gh failed after the push: the pushed branch goes too, so the same name can be retried; the delete failing is only a warning
async function undoPush(deps: PrDeps, git: Run, input: PrInput): Promise<void> {
  await git('git', hookless('push', '--no-verify', 'origin', '--delete', input.branch)).then(() => undefined, (err: unknown) =>
    deps.log.warn(`benchmark PR of experiment ${input.experimentId}: deleting the pushed branch failed (${errorClass(err)})`));
}

async function publish(deps: PrDeps, git: Run, gh: Run, input: PrInput, baseline: string, mark: (pushed: boolean) => void): Promise<BenchPrAnswer | BenchPrRefusal> {
  const conflict = await at('rebase', () => rebaseRun(git, input.branch, baseline, input.base));
  if (conflict !== undefined) return { error: 'conflict', files: conflict.files };
  await at('files', () => dropRunFiles(git, input.base));
  await at('push', () => git('git', hookless('push', '--no-verify', '--set-upstream', 'origin', `HEAD:refs/heads/${input.branch}`)));
  mark(true);
  try {
    return { url: await at('pr', () => createPr(gh, input)) };
  } catch (err) {
    await undoPush(deps, git, input);
    mark(false);
    throw err;
  }
}

// The cleanup never replaces the answer: a failure here is logged by its class and what is left is the user's to look at. Before a push the
// run ref stays: the next preview or PR fetches it again anyway
async function leave(deps: PrDeps, git: Run, input: PrInput, place: Place, pushed: boolean): Promise<void> {
  const warn = (what: string) => (err: unknown): void => deps.log.warn(`benchmark PR of experiment ${input.experimentId}: ${what} failed (${errorClass(err)})`);
  await place.leave(pushed).catch(warn('the cleanup'));
  if (pushed) await git('git', ['update-ref', '-d', benchRef(input.token)]).then(() => undefined, warn('deleting the run ref'));
}

/** A run's PR (#477): a refusal, the PR's URL, or a PrStepError. Where the rebase and push happen is the workspace's benchmarkPrIn. */
export async function openPr(deps: PrDeps, input: PrInput): Promise<BenchPrAnswer | BenchPrRefusal> {
  const git = inDir(deps.exec, input.workspace.path);
  if ((await at('fetch', () => remoteSha(git, input.branch))) !== undefined) return { error: 'branch-exists' };
  const { baseline, commits } = await at('fetch', () => fetchRun(git, input.repoGit, input.token, input.base));
  if (commits === 0) return { error: 'no-commits' };
  const place = input.workspace.benchmarkPrIn === 'worktree' ? await enterWorktree(git, input) : await enterCheckout(git, input);
  if ('error' in place) return place;
  let pushed = false;
  try {
    return await publish(deps, inDir(deps.exec, place.dir), inDir(deps.gh, place.dir), input, baseline, (value) => { pushed = value; });
  } finally {
    await leave(deps, git, input, place, pushed);
  }
}
