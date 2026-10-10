// The files a PR in conflict would conflict in (#758). GitHub's API does not list them; the task's worktree already holds the history, so git
// computes the merge there with no checkout touched. argv only, and nothing runs before the base and the head are checked.
import type { Logger } from './log.js';
import { isBranchName } from './merge-prompt.js';
import { isOid } from './pr-bodies.js';
import type { Exec } from './types.js';

const CONFLICTED = 1; // git merge-tree's exit code for a merge with conflicts

// The paths after the tree line, up to the blank line that ends them
function pathsOf(stdout: string): string[] {
  const [, ...rest] = stdout.split('\n');
  const end = rest.indexOf('');
  return end === -1 ? rest : rest.slice(0, end);
}

// The exit code of a failed git call, as execFile rejects it; the log line names the step and the code, never the worktree's path
const codeOf = (err: unknown): unknown => (typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined);

/** <remote>/{base} merged into {head} in `worktree` (#758, #854: the PR's workspace's base remote): [] when clean, the conflicted paths when not; undefined on any failure (git older
 * than 2.38 has no --write-tree, a head the worktree lacks, no network for the fetch), logged at debug. */
export async function conflictedFiles(worktree: string, base: string, head: string, exec: Exec, log: Pick<Logger, 'debug'>, remote = 'origin'): Promise<string[] | undefined> {
  if (!isBranchName(base) || !isOid(head)) return undefined;
  try {
    await exec('git', ['-C', worktree, 'fetch', remote, base]);
  } catch (err) {
    log.debug(`conflicted files: git fetch failed (exit ${String(codeOf(err))})`);
    return undefined;
  }
  try {
    await exec('git', ['-C', worktree, 'merge-tree', '--write-tree', '--name-only', '--no-messages', `${remote}/${base}`, head]);
    return [];
  } catch (err) {
    const { stdout } = err as { stdout?: unknown };
    if (codeOf(err) === CONFLICTED && typeof stdout === 'string') return pathsOf(stdout);
    log.debug(`conflicted files: git merge-tree failed (exit ${String(codeOf(err))})`);
    return undefined;
  }
}
