import { realpath, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { taskOfActivity } from './activities.js';
import { workspaceByName } from './config.js';
import type { Logger } from './log.js';
import { detectNested } from './nested-check.js';
import { samePath } from './same-path.js';
import { slugFor, worktreeRows } from './tasks.js';
import { removeTranscripts } from './transcript.js';
import { MEMORY_CAP_MIN, WORKSPACE_PRESET_COLORS, type Activity, type Config, type DeleteActivityScope, type Exec, type Session, type Task, type Workspace, type WorktreeRow } from './types.js';
import { gitOrWords } from './worktree-base.js';
import { nestedStatus } from './worktree-nested.js';
import { HIVE_DIR } from './hooks-settings.js';
import { listWorktrees, taskDir, WORKTREES_DIR } from './worktree.js';

// #746: an activity whose workspace left the Comb. Its worktree path still says which repository made it, because the Hive creates a worktree
// in exactly one place, <repo>/.hive/worktrees/<slug>; nothing else is ever read from the path. #747: and the worktrees tab lists their
// worktrees (strandedRows).

/** Whether the activity's workspace is no longer in the Comb: workspaceOf cannot answer for it, so the delete routes take this way instead. */
export const isStranded = (config: Pick<Config, 'comb'>, activity: Pick<Activity, 'workspace'>): boolean => workspaceByName(config, activity.workspace) === undefined;

/** The repo a worktree path of the Hive's shape belongs to, by the path alone: an absolute path that ends exactly at `.hive/worktrees/<slug>`.
 * Any other shape (a relative path, junk after the slug, a worktree elsewhere) is undefined and nothing is run or removed for it. */
export function worktreeRepo(activity: Activity, task: Task, platform: NodeJS.Platform = process.platform): string | undefined {
  if (activity.local || activity.worktree === undefined) return undefined;
  const names = platform === 'win32' ? win32 : posix;
  const slug = activity.slug ?? slugFor(task.item);
  const path = platform === 'win32' ? activity.worktree.replaceAll('/', '\\') : activity.worktree; // git and the OS both print C:/… on Windows
  const tail = [HIVE_DIR, WORKTREES_DIR, slug].join(names.sep);
  const suffix = `${names.sep}${tail}`;
  // A `.`/`..` slug or segment would make the checked path differ from the one the removal joins; a UNC path would reach another host
  if (BAD_SLUGS.has(slug) || /[/\\\0]/.test(slug) || !names.isAbsolute(path) || !path.endsWith(suffix)) return undefined;
  if (names.normalize(path) !== path || (platform === 'win32' && path.startsWith('\\\\'))) return undefined;
  const repo = path.slice(0, -suffix.length);
  return repo === '' ? undefined : repo;
}

const BAD_SLUGS = new Set(['', '.', '..']);
const WORKTREE_PREFIX = 'worktree ';
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** The repo that made the activity's worktree, confirmed by git (#746): it lists that slug's worktree or, when the folder is already gone from
 * disk, simply answers there. A path of another shape, a repo folder with no .git of its own or any git failure is undefined. One read, with the fsmonitor
 * off because the repo's config could name a monitor command. */
export async function strandedRepo(activity: Activity, task: Task, exec: Exec, platform: NodeJS.Platform = process.platform): Promise<{ repo: string } | undefined> {
  const repo = worktreeRepo(activity, task, platform);
  if (repo === undefined || activity.worktree === undefined || !(await exists(join(repo, '.git')))) return undefined; // a bare folder inside another repo would answer from that repo's git
  try {
    const listed = await gitOrWords(repo, ['-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain'], exec);
    const worktree = activity.worktree;
    if (!(await exists(worktree))) return (await exists(join(repo, HIVE_DIR, WORKTREES_DIR))) ? { repo } : undefined; // gone: only a repo the Hive made worktrees in
    const real = await realpath(worktree); // git lists real paths: a symlinked /tmp or home would never match the path as written
    const lists = listed.split('\n').some((line) => line.startsWith(WORKTREE_PREFIX) && [worktree, real].some((p) => samePath(line.slice(WORKTREE_PREFIX.length), p, platform)));
    return lists ? { repo } : undefined;
  } catch {
    return undefined;
  }
}

/** A workspace standing in for the removed one (#746): just its name and the repo, so deleteActivityOnDisk runs unchanged. It has no
 * setup or teardown (they went with the workspace); the nested repos are what git finds ignored in the repo now. */
async function standIn(name: string, repo: string, exec: Exec): Promise<Workspace> {
  return { name, path: repo, env: {}, memoryCap: MEMORY_CAP_MIN, color: WORKSPACE_PRESET_COLORS[0], fork: null, nestedRepos: await detectNested(repo, [], exec), notNestedRepos: [], benchmarkPrIn: 'worktree' };
}

/** The stand-in workspace of a stranded activity whose repo git confirms, or undefined when there is nothing on disk to remove (a local
 * activity, or a repo not confirmed): the caller forgets the activity then. A nested-repo read that fails rejects, and the caller keeps the activity. */
export async function strandedWorkspace(activity: Activity, task: Task, exec: Exec): Promise<Workspace | undefined> {
  if (activity.local) return undefined;
  const found = await strandedRepo(activity, task, exec);
  return found && standIn(activity.workspace, found.repo, exec);
}

/** The transcripts of a forgotten stranded activity, when the scope covers them (#746): only under a repo the path names in the Hive's shape,
 * confirmed or not, since the transcripts sit under the folder Claude ran in. A failure is logged and does not stop the deletion. */
export async function strandedTranscripts(activity: Activity, task: Task, sessions: Session[], scope: DeleteActivityScope, log: Pick<Logger, 'debug' | 'error'>): Promise<void> {
  const repo = worktreeRepo(activity, task);
  if (!scope.transcripts || repo === undefined) return;
  await removeTranscripts(taskDir(repo, activity), repo, sessions, log).catch((err: Error) => log.error(`transcripts #${task.item.id}: ${err.message}`));
}

type RowState = Parameters<typeof worktreeRows>[1];

// One stranded activity's rows (#747): only its own slug, since another worktree of that repo belongs to no stranded activity or to a live
// workspace that shares the repo, which lists it itself
async function activityRows(state: RowState, activity: Activity, task: Task, exec: Exec): Promise<WorktreeRow[]> {
  const standIn = await strandedWorkspace(activity, task, exec);
  if (!standIn) return [];
  const slug = activity.slug ?? slugFor(task.item);
  const listed = (await listWorktrees(standIn.path, process.platform, exec)).filter((w) => w.slug === slug);
  return Promise.all(worktreeRows(listed, state, activity.workspace).map(async (row): Promise<WorktreeRow> =>
    ({ ...row, nested: await nestedStatus(standIn, row.path, exec), workspaceGone: true })));
}

/** GET /worktrees' rows of the task activities whose workspace left the Comb (#747), in the State's order. Only a repo git confirms is read
 * (strandedWorkspace), and a failure reading one drops only that activity's rows; an activity with no task has no route to remove it. */
export async function strandedRows(state: RowState, config: Pick<Config, 'comb'>, exec: Exec): Promise<WorktreeRow[]> {
  const stranded = state.activities.flatMap((activity) => {
    const task = activity.kind === 'task' && !activity.local && isStranded(config, activity) ? taskOfActivity(state, activity.id) : undefined;
    return task ? [{ activity, task }] : [];
  });
  const rows = await Promise.all(stranded.map(({ activity, task }) => activityRows(state, activity, task, exec).catch((): WorktreeRow[] => [])));
  return rows.flat();
}
