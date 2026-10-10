// Settings › workspaces › repositório's pure edges (#854): the suggestion, the target switch and the last automatic sync.
import { taskOfActivity } from '../../activities.js';
import { type Activity, FORK_SYNCS, type ForkSync, type ForkSyncResult, type GitRemote, PR_TARGETS, type PrTarget, type State, type WorkspaceFork } from '../../types.js';

export const SUGGESTED_REMOTE = 'upstream'; // what `gh repo fork --clone` names the original
export const SUGGESTED_FORK: WorkspaceFork = { remote: SUGGESTED_REMOTE, pr: 'original' };

export const isPrTarget = (value: unknown): value is PrTarget => PR_TARGETS.some((p) => p === value);
export const isForkSync = (value: unknown): value is ForkSync => FORK_SYNCS.some((s) => s === value);

/** The GitHub repository a remote points at, else the remote's own name. */
export const repositoryOf = (remotes: readonly GitRemote[], name: string): string => remotes.find((r) => r.name === name)?.repository ?? name;

/** The suggestion shows (#854): a workspace never decided (null) with an upstream remote on GitHub. */
export const suggestsFork = (fork: WorkspaceFork | false | null, remotes: readonly GitRemote[]): boolean =>
  fork === null && remotes.some((r) => r.name === SUGGESTED_REMOTE && r.repository !== undefined);

/** Another PR target (#854): the original drops the sync; the fork or ask keep it, or start on GitHub. */
export function withPrTarget(fork: WorkspaceFork, pr: PrTarget): WorkspaceFork {
  if (pr === 'original') return { remote: fork.remote, pr };
  return { remote: fork.remote, pr, sync: fork.pr === 'original' ? 'github' : fork.sync };
}

const newer = (best: Activity | undefined, activity: Activity): Activity =>
  (best === undefined || (activity.sync?.at ?? '') > (best.sync?.at ?? '') ? activity : best);

/** The newest automatic sync among the workspace's activities, with its task's id (#854); none before the first. */
export function lastSync(state: Pick<State, 'tasks' | 'activities' | 'activityRecords'> | undefined, workspace: string): { sync: ForkSyncResult; task: string } | undefined {
  if (state === undefined) return undefined;
  const newest = state.activities.filter((a) => a.workspace === workspace && a.sync !== undefined).reduce<Activity | undefined>(newer, undefined);
  if (newest?.sync === undefined) return undefined;
  return { sync: newest.sync, task: taskOfActivity(state, newest.id)?.item.id ?? '' };
}
