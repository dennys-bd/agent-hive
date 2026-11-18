import { join } from 'node:path';
import type { Machine } from './machine.js';
import { type RestartPlan, restartWorktree } from './restart.js';
import type { Checkpoint } from './types.js';
import { gitOrWords, wordsOf } from './worktree.js';

// commit-tree needs an identity and the worktree's git may have none (a fresh machine, CI); the point is the Hive's, never a commit of the user's
const IDENTITY = { GIT_AUTHOR_NAME: 'Agent Hive', GIT_AUTHOR_EMAIL: 'hive@localhost', GIT_COMMITTER_NAME: 'Agent Hive', GIT_COMMITTER_EMAIL: 'hive@localhost' };

/** The ref that keeps checkpoint `n`'s restore point alive through a gc (#619), as the stage-start ref keeps a stage's start. */
export const checkpointRef = (slug: string, n: number): string => `refs/hive/${slug}/checkpoint/${n}`;

/** What a capture read and wrote (#619): HEAD, the restore point (HEAD itself on a clean worktree), and the branch HEAD was on. */
export interface CheckpointPoint { head: string; commit: string; branch: string }

// git on the temporary index (#619): fsmonitor off, as taskDiff's (the worker's config could name a monitor command); git's words on a failure
async function onIndex(machine: Machine, worktree: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await machine.exec('git', ['-C', worktree, '-c', 'core.fsmonitor=false', ...args], { env })).stdout;
  } catch (err) {
    throw new Error(wordsOf(err));
  }
}

// The worker's worktree status (#619), as taskDiff reads it: fsmonitor off (its config could name a monitor command the Hive would run) and no
// optional locks (a status would rewrite the user's index, racing the worker's own git)
async function statusOf(machine: Machine, worktree: string): Promise<string> {
  try {
    return (await machine.exec('git', ['--no-optional-locks', '-C', worktree, '-c', 'core.fsmonitor=false', 'status', '--porcelain'])).stdout;
  } catch (err) {
    throw new Error(wordsOf(err));
  }
}

// The worktree as `add -A` stages it (ignored files left out), committed on top of HEAD through an index of its own: the user's index and the
// worktree are never written, and no stash entry is made (the stash stack is shared across worktrees). The temp dir goes whatever happens.
async function pointOf(machine: Machine, worktree: string, head: string, n: number): Promise<string> {
  const dir = await machine.fs.mkdtemp(join(machine.info().tmpdir, 'hive-checkpoint-')); // the machine's temp dir: its index and its repo on one disk;
  try {
    const env = { ...process.env, ...IDENTITY, GIT_INDEX_FILE: join(dir, 'index') };
    await onIndex(machine, worktree, ['read-tree', 'HEAD'], env);
    await onIndex(machine, worktree, ['add', '-A'], env);
    const tree = (await onIndex(machine, worktree, ['write-tree'], env)).trim();
    return (await onIndex(machine, worktree, ['commit-tree', tree, '-p', head, '-m', `hive checkpoint ${n}`], env)).trim();
  } finally {
    await machine.fs.rm(dir, { recursive: true, force: true });
  }
}

/** The worktree as checkpoint `n` of `slug` (#619): its restore point kept under checkpointRef in `repo`. A clean worktree's point is HEAD. No HEAD
 * printed rejects, as recordStageStart records nothing then. */
export async function captureCheckpoint(machine: Machine, repo: string, worktree: string, slug: string, n: number): Promise<CheckpointPoint> {
  const head = (await gitOrWords(worktree, ['rev-parse', 'HEAD'], machine.exec)).trim();
  if (head === '') throw new Error('git printed no HEAD');
  const branch = (await gitOrWords(worktree, ['symbolic-ref', '--short', 'HEAD'], machine.exec).catch(() => '')).trim();
  const dirty = (await statusOf(machine, worktree)).trim() !== '';
  const commit = dirty ? await pointOf(machine, worktree, head, n) : head;
  await gitOrWords(repo, ['update-ref', checkpointRef(slug, n), commit], machine.exec);
  return { head, commit, branch };
}

/** A restore's git (#619): Restart's own (its own-checkout guard, the reset, the clean, the new branch in branch mode) to the checkpoint's head, then
 * the point's tree read into the worktree and the index reset to HEAD, so the checkpoint's work comes back unstaged, its untracked files untracked. */
export async function restoreWorktree(machine: Machine, worktree: string, branch: string, checkpoint: Pick<Checkpoint, 'head' | 'commit'>, plan: RestartPlan): Promise<void> {
  await restartWorktree(machine, worktree, branch, checkpoint.head, plan);
  if (checkpoint.commit === checkpoint.head) return;
  await gitOrWords(worktree, ['read-tree', '-u', '--reset', checkpoint.commit], machine.exec);
  await gitOrWords(worktree, ['reset', '-q'], machine.exec);
}

/** Drops every checkpoint ref of `slug` with the activity (#619); none is nothing to drop. */
export async function dropCheckpoints(machine: Machine, repo: string, slug: string): Promise<void> {
  const listed = await gitOrWords(repo, ['for-each-ref', '--format=%(refname)', `refs/hive/${slug}/checkpoint/`], machine.exec);
  for (const ref of listed.split('\n').filter((line) => line !== '')) await gitOrWords(repo, ['update-ref', '-d', ref], machine.exec);
}
