// Where a decomposition's file lives, and its delivery (#936): the git checkout that holds the file (the goal's worktree, or a docsRepo's,
// wherever it sits), the GitHub repository of its origin, its current branch and the file's path in it. What the Design: links point at and
// where the delivery commits, pushes and opens its PR. Git through execFile with argv arrays.
import { dirname, relative } from 'node:path';
import { originRepository } from './repos/repositories.js';
import type { Exec } from './types.js';

/** The file's checkout (#936): its toplevel, its origin's owner/name, its current branch, and the file's path relative to the toplevel. */
export interface FileCheckout { toplevel: string; repository: string; branch: string; path: string }

/** The checkout of `file`, a real absolute path (#936), learned from the file itself: the Hive keeps no copy of the conventions. No checkout,
 * an origin off GitHub or a detached HEAD is refused with fixed words before anything is written. */
export async function fileCheckout(exec: Exec, file: string): Promise<FileCheckout> {
  const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  // git answers the toplevel with its symlinks resolved, as the file's real path is, so the relative path holds
  const toplevel = await git(dirname(file), 'rev-parse', '--show-toplevel').catch(() => '');
  if (toplevel === '') throw new Error('the decomposition file is in no git checkout');
  const repository = await originRepository(exec, toplevel);
  if (repository === undefined) throw new Error('the decomposition file\'s checkout has no GitHub origin');
  const branch = await git(toplevel, 'branch', '--show-current');
  if (branch === '') throw new Error('the decomposition file\'s checkout is on no branch: nothing to push');
  return { toplevel, repository, branch, path: relative(toplevel, file) };
}
