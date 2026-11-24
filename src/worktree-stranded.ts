import { taskOfActivity } from './activities.js';
import { workspaceByName } from './config.js';
import type { Logger } from './log.js';
import type { Machine } from './machine.js';
import { detectNested } from './nested-check.js';
import { isWin32Paths, samePath } from './same-path.js';
import { slugFor, worktreeRows } from './tasks.js';
import { removeTranscripts } from './transcript.js';
import { LOCAL_MACHINE, MEMORY_CAP_MIN, WORKSPACE_PRESET_COLORS, type Activity, type Config, type DeleteActivityScope, type Session, type Task, type Workspace, type WorktreeRow } from './types.js';
import { gitOrWords } from './worktree-base.js';
import { nestedStatus } from './worktree-nested.js';
import { HIVE_DIR } from './hooks-settings.js';
import { listWorktrees, taskDir, WORKTREES_DIR } from './worktree.js';

// #746: an activity whose workspace left the Comb. Its worktree path still says which repository made it, because the Hive creates a worktree
// in exactly one place, <repo>/.hive/worktrees/<slug>; nothing else is ever read from the path. #747: and the worktrees tab lists their
// worktrees (strandedRows). #882: every read and git call goes through the machine the caller passes, the host's for a stranded worktree (#932).

/** Whether the activity's workspace is no longer in the Comb: workspaceOf cannot answer for it, so the delete routes take this way instead. */
export const isStranded = (config: Pick<Config, 'comb'>, activity: Pick<Activity, 'workspace'>): boolean => workspaceByName(config, activity.workspace) === undefined;

type StrandedMachine = Pick<Machine, 'exec' | 'fs' | 'paths'>; // server-worktrees.ts passes the host's, activity-delete.ts the activity's (#932)

/** The repo a worktree path of the Hive's shape belongs to, by the path alone: an absolute path that ends exactly at `.hive/worktrees/<slug>`.
 * Any other shape (a relative path, junk after the slug, a worktree elsewhere) is undefined and nothing is run or removed for it. */
export function worktreeRepo(machine: Pick<Machine, 'paths'>, activity: Activity, task: Task): string | undefined {
  const { paths } = machine;
  if (activity.local || activity.worktree === undefined) return undefined;
  const isWin32 = isWin32Paths(paths);
  const slug = activity.slug ?? slugFor(task.item);
  const path = isWin32 ? activity.worktree.replaceAll('/', '\\') : activity.worktree; // git and the OS both print C:/… on Windows
  const tail = [HIVE_DIR, WORKTREES_DIR, slug].join(paths.sep);
  const suffix = `${paths.sep}${tail}`;
  // A `.`/`..` slug or segment would make the checked path differ from the one the removal joins; a UNC path would reach another host
  if (BAD_SLUGS.has(slug) || /[/\\\0]/.test(slug) || !paths.isAbsolute(path) || !path.endsWith(suffix)) return undefined;
  if (paths.normalize(path) !== path || (isWin32 && path.startsWith('\\\\'))) return undefined;
  const repo = path.slice(0, -suffix.length);
  return repo === '' ? undefined : repo;
}

const BAD_SLUGS = new Set(['', '.', '..']);
const WORKTREE_PREFIX = 'worktree ';
const exists = (machine: Pick<Machine, 'fs'>, path: string): Promise<boolean> => machine.fs.stat(path).then(() => true, () => false);

/** The repo that made the activity's worktree, confirmed by git (#746): it lists that slug's worktree or, when the folder is already gone from
 * disk, simply answers there. A path of another shape, a repo folder with no .git of its own or any git failure is undefined. One read, with the fsmonitor
 * off because the repo's config could name a monitor command. */
export async function strandedRepo(machine: StrandedMachine, activity: Activity, task: Task): Promise<{ repo: string } | undefined> {
  const { paths } = machine;
  const repo = worktreeRepo(machine, activity, task);
  if (repo === undefined || activity.worktree === undefined || !(await exists(machine, paths.join(repo, '.git')))) return undefined; // a bare folder inside another repo would answer from that repo's git
  try {
    const listed = await gitOrWords(repo, ['-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain'], machine.exec);
    const worktree = activity.worktree;
    if (!(await exists(machine, worktree))) return (await exists(machine, paths.join(repo, HIVE_DIR, WORKTREES_DIR))) ? { repo } : undefined; // gone: only a repo the Hive made worktrees in
    const real = await machine.fs.realpath(worktree); // git lists real paths: a symlinked /tmp or home would never match the path as written
    const lists = listed.split('\n').some((line) => line.startsWith(WORKTREE_PREFIX) && [worktree, real].some((p) => samePath(line.slice(WORKTREE_PREFIX.length), p, paths)));
    return lists ? { repo } : undefined;
  } catch {
    return undefined;
  }
}

/** A workspace standing in for the removed one (#746): just its name and the repo, so deleteActivityOnDisk runs unchanged. It has no
 * setup or teardown (they went with the workspace); the nested repos are what git finds ignored in the repo now. */
async function standIn(machine: StrandedMachine, name: string, repo: string): Promise<Workspace> {
  return { name, path: repo, env: {}, memoryCap: MEMORY_CAP_MIN, color: WORKSPACE_PRESET_COLORS[0], fork: null, nestedRepos: await detectNested(machine, repo, []), notNestedRepos: [], benchmarkPrIn: 'worktree', machine: LOCAL_MACHINE, variables: {} };
}

/** The stand-in workspace of a stranded activity whose repo git confirms, or undefined when there is nothing on disk to remove (a local
 * activity, or a repo not confirmed): the caller forgets the activity then. A nested-repo read that fails rejects, and the caller keeps the activity. */
export async function strandedWorkspace(machine: StrandedMachine, activity: Activity, task: Task): Promise<Workspace | undefined> {
  if (activity.local) return undefined;
  const found = await strandedRepo(machine, activity, task);
  return found && standIn(machine, activity.workspace, found.repo);
}

/** The transcripts of a forgotten stranded activity, when the scope covers them (#746): only under a repo the path names in the Hive's shape,
 * confirmed or not, since the transcripts sit under the folder Claude ran in. A failure is logged and does not stop the deletion. */
export async function strandedTranscripts(machine: Machine, activity: Activity, task: Task, sessions: Session[], scope: DeleteActivityScope, log: Pick<Logger, 'debug' | 'error'>): Promise<void> {
  const repo = worktreeRepo(machine, activity, task);
  if (!scope.transcripts || repo === undefined) return;
  await removeTranscripts(machine, taskDir(machine.paths, repo, activity), repo, sessions, log).catch((err: Error) => log.error(`transcripts #${task.item.id}: ${err.message}`));
}

type RowState = Parameters<typeof worktreeRows>[1];

// One stranded activity's rows (#747): only its own slug, since another worktree of that repo belongs to no stranded activity or to a live
// workspace that shares the repo, which lists it itself
async function activityRows(machine: StrandedMachine, state: RowState, activity: Activity, task: Task): Promise<WorktreeRow[]> {
  const standIn = await strandedWorkspace(machine, activity, task);
  if (!standIn) return [];
  const slug = activity.slug ?? slugFor(task.item);
  const listed = (await listWorktrees(machine, standIn.path)).filter((w) => w.slug === slug);
  return Promise.all(worktreeRows(listed, state, activity.workspace).map(async (row): Promise<WorktreeRow> =>
    ({ ...row, nested: await nestedStatus(machine, standIn, row.path), workspaceGone: true })));
}

/** GET /worktrees' rows of the task activities whose workspace left the Comb (#747), in the State's order. Only a repo git confirms is read
 * (strandedWorkspace), and a failure reading one drops only that activity's rows; an activity with no task has no route to remove it. */
export async function strandedRows(machine: StrandedMachine, state: RowState, config: Pick<Config, 'comb'>): Promise<WorktreeRow[]> {
  const stranded = state.activities.flatMap((activity) => {
    const task = activity.kind === 'task' && !activity.local && isStranded(config, activity) ? taskOfActivity(state, activity.id) : undefined;
    return task ? [{ activity, task }] : [];
  });
  const rows = await Promise.all(stranded.map(({ activity, task }) => activityRows(machine, state, activity, task).catch((): WorktreeRow[] => [])));
  return rows.flat();
}
