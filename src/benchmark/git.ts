import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { cleanEnv, inDir, type Run } from './exec.js';

/** Neutral, as the first commit of any repository: the workers must not know (#105). */
export const BASELINE_MESSAGE = 'chore: initial commit';
export const BASELINE_BRANCH = 'main';
export const ORIGIN_DIR = 'repo.git';
export const NESTED_DIR = 'nested';
export const CLONE_DIR = 'clone';
// The harness's own files and mentions (#105, #79), out of every baseline until #479 retires the harness: constants, since they exist only in this repository
/** What the code baseline drops (#105, the user): the harness and its tests. */
export const EXPERIMENT_PATHS = ['scripts/experiment', 'test/experiment'] as const;
/** What a nested baseline drops (#79): every doc naming the harness, as git grep -E reads it. The #105 spec and plan are among them, and
 *  so is any plan of another delivery that lists a harness file it touched: a worker reading it would learn of the experiment. */
export const EXPERIMENT_MENTION = 'scripts/experiment|test/experiment|skills-ab-experiment|experiment:skills|benchmark-view-decomposition';
const EXPERIMENT_WORD = /experiment/i;
const EXPERIMENT_GLOB = ' "dist/test/experiment/*.test.js"';
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // reaches git's argv: no leading -, no .., no revision syntax

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
const range = (baseline: string, branch: string): string => `${baseline}...origin/${branch}`;
export const taskBranchPrefix = (prefix: string): string => `hive/${prefix}-`;
export const nestedOrigin = (dir: string, path: string): string => join(dir, NESTED_DIR, `${path}.git`);
export const runBranch = (token: string): string => `work/${token}`;
export const runPrefix = (token: string): string => token.toUpperCase();

export interface PrefixedWorktree { path: string; branch: string }

/** The worktrees holding a branch under `refPrefix`, from `git worktree list --porcelain`. Every worktree of the repo shares its branches,
 *  so a run left behind by another worktree keeps the branch checked out and the next `git worktree add` refuses it. */
export function worktreesOn(porcelain: string, refPrefix: string): PrefixedWorktree[] {
  return porcelain.split('\n\n').flatMap((block) => {
    const rows = block.split('\n');
    const path = rows.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    const ref = rows.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    return path && ref?.startsWith(refPrefix) ? [{ path, branch: ref.slice('refs/heads/'.length) }] : [];
  });
}

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
export function assertBaselineClean(lsTree: string, packageJson?: string): void {
  const leak = lines(lsTree).find((path) => EXPERIMENT_PATHS.some((e) => path === e || path.startsWith(`${e}/`)));
  if (leak !== undefined) throw new Error(`the baseline would carry an experiment file: ${leak}`);
  if (packageJson !== undefined && EXPERIMENT_WORD.test(packageJson)) throw new Error('the baseline package.json still names the experiment');
}

export interface BaselineInput { source: string; scratch: string }
export interface NestedBaselineInput extends BaselineInput { files?: readonly { from: string; to: string }[] }
interface OrphanSteps { edit(env: NodeJS.ProcessEnv): Promise<void>; check(tree: string): Promise<void> }

async function addBlob(run: Run, env: NodeJS.ProcessEnv, from: string, to: string): Promise<void> {
  const sha = (await run('git', ['hash-object', '-w', '--', from])).stdout.trim();
  await run('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${to}`], { env });
}

/** The source's tree, edited, as an orphan commit (#105): the source's history names the experiment. A private index leaves the working
 *  tree and the user's index alone. */
async function orphanCommit(run: Run, input: BaselineInput, steps: OrphanSteps): Promise<string> {
  const index = join(input.scratch, 'baseline.index');
  const env = cleanEnv(process.env, { GIT_INDEX_FILE: index });
  try {
    await run('git', ['read-tree', input.source], { env });
    await steps.edit(env);
    const tree = (await run('git', ['write-tree'], { env })).stdout.trim();
    await steps.check(tree);
    const commit = (await run('git', ['commit-tree', tree, '-m', BASELINE_MESSAGE])).stdout.trim();
    await run('git', ['update-ref', `refs/bases/${commit.slice(0, 12)}`, commit]);
    return commit;
  } finally {
    await rm(index, { force: true });
  }
}

/** The code baseline: the source's tree without the harness, its tests and its scripts. */
export async function experimentBaseline(run: Run, input: BaselineInput): Promise<string> {
  const pkg = join(input.scratch, 'package.json');
  // Any repository can be a seed (#471): one with no root package.json has no script to strip
  const hasPkg = (await run('git', ['ls-tree', '--name-only', input.source, '--', 'package.json'])).stdout.trim() !== '';
  try {
    return await orphanCommit(run, input, {
      edit: async (env) => {
        await run('git', ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...EXPERIMENT_PATHS], { env });
        if (!hasPkg) return;
        await writeFile(pkg, strippedPackageJson((await run('git', ['show', `${input.source}:package.json`])).stdout));
        await addBlob(run, env, pkg, 'package.json');
      },
      check: async (tree) => assertBaselineClean((await run('git', ['ls-tree', '-r', '--name-only', tree])).stdout, hasPkg ? await readFile(pkg, 'utf8') : undefined),
    });
  } finally {
    await rm(pkg, { force: true });
  }
}

// git grep exits 1 when nothing matches; its lines read <treeish>:<path>
async function mentions(run: Run, treeish: string): Promise<string[]> {
  try {
    return lines((await run('git', ['grep', '-l', '-I', '-E', EXPERIMENT_MENTION, treeish, '--'])).stdout).map((l) => l.slice(treeish.length + 1));
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return [];
    throw err;
  }
}

/** A nested repo's baseline (#79), run in its clone: the source's tree without any file that names the harness, plus the given files. */
export async function nestedBaseline(run: Run, input: NestedBaselineInput): Promise<string> {
  return orphanCommit(run, input, {
    edit: async (env) => {
      const named = await mentions(run, input.source);
      if (named.length > 0) await run('git', ['rm', '-q', '--cached', '--', ...named], { env });
      for (const file of input.files ?? []) await addBlob(run, env, file.from, file.to);
    },
    check: async (tree) => {
      const leak = (await mentions(run, tree))[0];
      if (leak !== undefined) throw new Error(`the nested baseline would carry a file that names the experiment: ${leak}`);
    },
  });
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

// A forged .git/worktrees entry names any path: only what sits inside the clone folder is removed (the worker can write that folder's git data).
// Resolved first, so a `<clone>/../elsewhere` entry does not pass as inside
const isInside = (root: string, path: string): boolean => resolve(path).startsWith(`${resolve(root)}${sep}`);

async function dropIn(run: Run, prefix: string, root: string): Promise<void> {
  const branches = taskBranchPrefix(prefix);
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain']);
  for (const { path } of worktreesOn(stdout, `refs/heads/${branches}`).filter((w) => isInside(root, w.path))) await run('git', ['worktree', 'remove', '--force', path]);
  await run('git', ['worktree', 'prune']);
  for (const branch of lines((await run('git', ['branch', '--list', `${branches}*`, '--format=%(refname:short)'])).stdout)) await run('git', ['branch', '-D', branch]);
  const remote = lines((await run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branches}*`])).stdout);
  for (const ref of remote.map((l) => l.split(/\s+/)[1] ?? '').filter((r) => r !== '')) await run('git', ['push', 'origin', '--delete', ref]);
}

/** This run's task worktrees and branches, locally and on origin, in each nested clone first (`nested`: their absolute paths), then in
 *  the clone `run` is bound to (`root`: its folder, which every worktree removed must sit in). Only `hive/<prefix>-*`: never another run's, never the run branch. */
export async function dropRunWorktrees(run: Run, prefix: string, root: string, nested: readonly string[] = []): Promise<void> {
  // A nested worktree lives inside its task's worktree: its repo forgets it before the outer removal takes the folder
  for (const dir of nested) await dropIn(inDir(run, dir), prefix, root);
  await dropIn(run, prefix, root);
}

export const diffShortstat = async (run: Run, baseline: string, branch: string): Promise<string> => (await run('git', ['diff', '--shortstat', range(baseline, branch)])).stdout;
export const fullDiff = async (run: Run, baseline: string, branch: string): Promise<string> => (await run('git', ['diff', range(baseline, branch)])).stdout;

export async function addWorktree(run: Run, path: string, ref: string, cwd?: string): Promise<void> {
  await run('git', ['worktree', 'add', '--detach', path, ref], cwd === undefined ? {} : { cwd });
}

export async function removeWorktree(run: Run, path: string, cwd?: string): Promise<void> {
  const opts = cwd === undefined ? {} : { cwd };
  await run('git', ['worktree', 'remove', '--force', path], opts);
  await run('git', ['worktree', 'prune'], opts);
}
