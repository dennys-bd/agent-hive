import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { inDir, type Run } from '../../src/benchmark/exec.js';
import { sandboxPaths, taskBranchPrefix } from '../../src/benchmark/git.js';

const DOC_DIRS = { spec: 'agent/hive/specs', plan: 'agent/hive/plans' } as const; // inside the docs repository (#79)
export const DOCS_CLONE = 'docs';
const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

/** The lab's docs clone, at docs/ as CLAUDE.md lays it out: its git calls and its paths for the sandbox. Its origin must be a local
 *  repository, as the code side's is, so the run branches and the workers' commits never reach the real docs repository (#79). */
export async function docsClone(run: Run, root: string): Promise<{ docs: Run; paths: { gitDir: string; origin: string } }> {
  const cwd = join(root, DOCS_CLONE);
  if (!existsSync(join(cwd, '.git'))) throw new Error(`no docs clone at ${cwd}: clone the docs repository there, from a local origin (scripts/experiment/README.md)`);
  const docs = inDir(run, cwd);
  const paths = await sandboxPaths(docs);
  if (!isAbsolute(paths.origin)) throw new Error(`the docs clone's origin must be a local repository, not ${paths.origin}: a run would push to it`);
  return { docs, paths };
}

/** A removed task worktree took its docs worktree with it: the docs clone forgets it, and keeps its branch (#79). */
export async function pruneDocs(docs: Run): Promise<void> {
  await docs('git', ['worktree', 'prune']);
}

/** The specs and plans a run's tasks added, specs first, each sorted by path: read in the docs clone, from each task's docs branch
 *  (named after its code branch by the worktree setup) against the docs baseline (#79). Those branches are never pushed. */
export async function runDocs(docs: Run, baseline: string, prefix: string): Promise<{ kind: 'spec' | 'plan'; text: string }[]> {
  const branches = lines((await docs('git', ['branch', '--list', `${taskBranchPrefix(prefix)}*`, '--format=%(refname:short)'])).stdout);
  const added: { branch: string; path: string }[] = [];
  for (const branch of branches) {
    const paths = lines((await docs('git', ['diff', '--name-only', '--diff-filter=A', `${baseline}...${branch}`, '--', DOC_DIRS.spec, DOC_DIRS.plan])).stdout);
    added.push(...paths.map((path) => ({ branch, path })));
  }
  const ordered = (['spec', 'plan'] as const).flatMap((kind) => added.filter((d) => d.path.startsWith(`${DOC_DIRS[kind]}/`)).sort((x, y) => x.path.localeCompare(y.path)).map((d) => ({ kind, ...d })));
  return Promise.all(ordered.map(async ({ kind, branch, path }) => ({ kind, text: (await docs('git', ['show', `${branch}:${path}`])).stdout })));
}
