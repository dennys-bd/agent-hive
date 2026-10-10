import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testWorktrees } from '../test-home.js';
import { cleanEnv, type Run } from './exec.js';
import { EXPERIMENT_PATHS } from './seed.js';

/** Neutral, as any handoff commit of the repository (#105, the user: the workers must not know). */
export const BASELINE_MESSAGE = 'docs: Monitor View design handoff';
const EXPERIMENT_WORD = /experiment/i;
const EXPERIMENT_GLOB = ' "dist/test/experiment/*.test.js"';
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // reaches git's argv: no leading -, no .., no revision syntax
const DOC_DIRS = { spec: 'docs/superpowers/specs', plan: 'docs/superpowers/plans' } as const;

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
const range = (baseline: string, branch: string): string => `${baseline}...origin/${branch}`;
export const taskBranchPrefix = (prefix: string): string => `hive/${prefix}-`;

export const isPlainRef = (ref: string): boolean => PLAIN_REF.test(ref) && !ref.includes('..');

export function requireRef(ref: string): string {
  if (!isPlainRef(ref)) throw new Error(`--baseline must be a plain ref (no leading -, no .., no revision syntax): ${ref}`);
  return ref;
}

export const repoRoot = async (run: Run): Promise<string> => (await run('git', ['rev-parse', '--show-toplevel'])).stdout.trim();

/** The lab clone's commits go unsigned: the user's signing agent sits behind a socket the workers' sandbox cannot reach, and their
 *  commits must not carry the user's key anyway. Local config, shared by every worktree of the clone. */
export async function unsignedCommits(run: Run): Promise<void> {
  await run('git', ['config', '--local', 'commit.gpgsign', 'false']);
  await run('git', ['config', '--local', 'tag.gpgsign', 'false']);
}

/** The clone's git folder (where every worktree's commits land) and its origin, for the workers' sandbox (sandbox.ts). */
export async function sandboxPaths(run: Run): Promise<{ gitDir: string; origin: string }> {
  const gitDir = (await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  return { gitDir, origin: (await run('git', ['remote', 'get-url', 'origin'])).stdout.trim() };
}

export async function resolveBaseline(run: Run, ref: string): Promise<string> {
  const plain = requireRef(ref);
  await run('git', ['fetch', 'origin']);
  return (await run('git', ['rev-parse', '--verify', '--end-of-options', `${plain}^{commit}`])).stdout.trim();
}

export function strippedPackageJson(text: string): string {
  const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
  // Any script named after or running the harness goes, whatever its prefix (`experiment:*`, the `run:experiment-*` previews)
  const scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {})
    .map(([name, line]): [string, string] => [name, line.replaceAll(EXPERIMENT_GLOB, '')]).filter(([name, line]) => !EXPERIMENT_WORD.test(`${name} ${line}`)));
  return `${JSON.stringify({ ...pkg, scripts }, null, 2)}\n`;
}

/** The last guard: the tree the workers start from holds no experiment file and no experiment script. */
export function assertBaselineClean(lsTree: string, packageJson: string): void {
  const leak = lines(lsTree).find((path) => EXPERIMENT_PATHS.some((e) => path === e || path.startsWith(`${e}/`)));
  if (leak !== undefined) throw new Error(`the baseline would carry an experiment file: ${leak}`);
  if (/experiment/i.test(packageJson)) throw new Error('the baseline package.json still names the experiment');
}

export interface BaselineInput { source: string; files: readonly { from: string; to: string }[]; scratch: string }

async function addBlob(run: Run, env: NodeJS.ProcessEnv, from: string, to: string): Promise<void> {
  const sha = (await run('git', ['hash-object', '-w', '--', from])).stdout.trim();
  await run('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${to}`], { env });
}

/** The source's tree without the experiment and with the handoff, as an orphan commit (#105): the source's history names the experiment.
 *  A private index leaves the working tree and the user's index alone. */
export async function experimentBaseline(run: Run, input: BaselineInput): Promise<string> {
  const env = cleanEnv(process.env, { GIT_INDEX_FILE: join(input.scratch, 'baseline.index') });
  const pkg = join(input.scratch, 'package.json');
  try {
    await run('git', ['read-tree', input.source], { env });
    await run('git', ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...EXPERIMENT_PATHS], { env });
    await writeFile(pkg, strippedPackageJson((await run('git', ['show', `${input.source}:package.json`])).stdout));
    for (const file of [{ from: pkg, to: 'package.json' }, ...input.files]) await addBlob(run, env, file.from, file.to);
    const tree = (await run('git', ['write-tree'], { env })).stdout.trim();
    assertBaselineClean((await run('git', ['ls-tree', '-r', '--name-only', tree])).stdout, await readFile(pkg, 'utf8'));
    const commit = (await run('git', ['commit-tree', tree, '-m', BASELINE_MESSAGE])).stdout.trim();
    await run('git', ['update-ref', `refs/bases/monitor-view-${commit.slice(0, 12)}`, commit]);
    return commit;
  } finally {
    await Promise.all([rm(join(input.scratch, 'baseline.index'), { force: true }), rm(pkg, { force: true })]);
  }
}

export async function remoteSha(run: Run, branch: string): Promise<string | undefined> {
  return lines((await run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).stdout)[0]?.split(/\s+/)[0];
}

export async function fetchBranch(run: Run, branch: string): Promise<void> {
  await run('git', ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

/** The run branch at the baseline, pushed. A fresh token never names an existing branch; one that does is refused, never overwritten. */
export async function createRunBranch(run: Run, branch: string, sha: string): Promise<void> {
  if ((await remoteSha(run, branch)) !== undefined) throw new Error(`${branch} is already on origin`);
  await run('git', ['branch', '-f', branch, sha]);
  await run('git', ['push', '-u', 'origin', branch]);
}

/** This run's task worktrees and branches, locally and on origin, as test-hive.ts does for TEST-. Never the other arm's: they have another prefix. */
export async function dropRunWorktrees(run: Run, prefix: string): Promise<void> {
  const branches = taskBranchPrefix(prefix);
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain']);
  for (const { path } of testWorktrees(stdout, `refs/heads/${branches}`)) await run('git', ['worktree', 'remove', '--force', path]);
  await run('git', ['worktree', 'prune']);
  for (const branch of lines((await run('git', ['branch', '--list', `${branches}*`, '--format=%(refname:short)'])).stdout)) await run('git', ['branch', '-D', branch]);
  const remote = lines((await run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branches}*`])).stdout);
  for (const ref of remote.map((l) => l.split(/\s+/)[1] ?? '').filter((r) => r !== '')) await run('git', ['push', 'origin', '--delete', ref]);
}

export const diffShortstat = async (run: Run, baseline: string, branch: string): Promise<string> => (await run('git', ['diff', '--shortstat', range(baseline, branch)])).stdout;
export const fullDiff = async (run: Run, baseline: string, branch: string): Promise<string> => (await run('git', ['diff', range(baseline, branch)])).stdout;

export async function addedDocs(run: Run, baseline: string, branch: string): Promise<{ kind: 'spec' | 'plan'; path: string }[]> {
  const paths = lines((await run('git', ['diff', '--name-only', '--diff-filter=A', range(baseline, branch), '--', DOC_DIRS.spec, DOC_DIRS.plan])).stdout).sort();
  return (['spec', 'plan'] as const).flatMap((kind) => paths.filter((p) => p.startsWith(`${DOC_DIRS[kind]}/`)).map((path) => ({ kind, path })));
}

export const showFile = async (run: Run, branch: string, path: string): Promise<string> => (await run('git', ['show', `origin/${branch}:${path}`])).stdout;

export async function addWorktree(run: Run, path: string, ref: string, cwd?: string): Promise<void> {
  await run('git', ['worktree', 'add', '--detach', path, ref], cwd === undefined ? {} : { cwd });
}

export async function removeWorktree(run: Run, path: string, cwd?: string): Promise<void> {
  const opts = cwd === undefined ? {} : { cwd };
  await run('git', ['worktree', 'remove', '--force', path], opts);
  await run('git', ['worktree', 'prune'], opts);
}
