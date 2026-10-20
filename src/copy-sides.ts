import { activityOf, localWorkspaceOf, taskOfActivity } from './activities.js';
import { keptTarget, liveTarget, UNKNOWN_ACTIVITY_MESSAGE } from './activity-routes.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { hasDirectory } from './local-sessions.js';
import { openTask, workspaceOf, type Refusal } from './server-tasks.js';
import { sameOwner } from './session-copy.js';
import type { Session, Config, Exec, SessionRef, SessionTarget, Worker, State } from './types.js';
import { ranAgent } from './agents.js';
import { runners } from './agents/registry.js';
import { taskDir, workDir } from './worktree.js';

// What a copy (#587) reads of its two ends: where each one runs, where its transcript may be, and the notice the new run is told.

/** One end of a copy: where claude runs, whether that directory exists, the dirs its transcript may sit in, and how the notice names it. */
export interface CopySide { cwd: string; onDisk: boolean; transcriptCwds: string[]; label: string }

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const UNKNOWN_WORKSPACE = 'workspace desconhecido';
const UNKNOWN_SESSION = 'sessão desconhecida';
const SAME_END = 'a sessão já está aqui';
const NO_DIRECTORY = 'esta atividade não tem diretório';
const NOTICE_TAIL = 'Only the conversation came along: the files, the branch and the uncommitted changes it mentions stayed where they were. Read the code here before relying on what was said about it.';

const localSide = (path: string, name: string): CopySide => ({ cwd: path, onDisk: true, transcriptCwds: [path], label: `the local checkout of ${name}` });
// #191: a lean task before its first poll has no title
const taskLabel = (task: { item: { id: string; title: string } }): string => (task.item.title === '' ? `task ${task.item.id}` : `task ${task.item.id} (${task.item.title})`);

// A local record's session: its workspace's checkout (#587)
function localSource(config: Pick<Config, 'comb'>, name: string, session: Session | undefined): { side: CopySide; session: Session } | Refusal {
  const workspace = workspaceByName(config, name);
  if (!workspace) return { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE };
  return session ? { session, side: localSide(workspace.path, workspace.name) } : { status: HTTP_CONFLICT, message: UNKNOWN_SESSION };
}

/** The session a copy starts from and where it lives, or the refusal naming what is unknown. `from` names a record (#629): a deleted activity's
 * kept session copies as it did from its task. */
export function sourceSide(state: State, config: Pick<Config, 'comb'>, from: SessionRef): { side: CopySide; session: Session } | Refusal {
  const kept = keptTarget(state, from.activityId);
  if ('status' in kept) return kept;
  const { record, task } = kept;
  const session = record.sessions.find((s) => s.id === from.sessionId);
  const local = localWorkspaceOf(record.id);
  if (local !== undefined) return localSource(config, local, session);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_ACTIVITY_MESSAGE };
  if (!session) return { status: HTTP_CONFLICT, message: UNKNOWN_SESSION };
  const workspace = workspaceOf(config, task);
  if ('status' in workspace) return workspace;
  const live = activityOf(state, task.item.itemId);
  const dir = workDir(workspace.path, task, live, record); // a kept session's transcript still sits in the deleted worktree's dir (#208, #629)
  const label = taskLabel(task);
  // A repo session (#208) runs in the main repo, and its transcript may still sit in the worktree's dir
  return session.repo
    ? { session, side: { cwd: workspace.path, onDisk: true, transcriptCwds: [dir, workspace.path], label } }
    : { session, side: { cwd: dir, onDisk: hasDirectory(live), transcriptCwds: [dir], label } };
}

/** Where the copy goes: a live activity (#629), a task's with a directory or a workspace's checkout; never the source's own end. */
export function targetSide(state: State, config: Pick<Config, 'comb'>, to: SessionTarget, from: SessionRef): CopySide | Refusal {
  if (sameOwner(from, to)) return { status: HTTP_CONFLICT, message: SAME_END };
  const target = liveTarget(state, to.activityId);
  if ('status' in target) return target;
  if (target.activity.kind === 'local') {
    const workspace = workspaceByName(config, target.activity.workspace);
    return workspace ? localSide(workspace.path, workspace.name) : { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE };
  }
  const opened = openTask(state, target.task?.item.itemId ?? '');
  if ('status' in opened) return opened;
  const { task, activity } = opened;
  if (!activity || !hasDirectory(activity)) return { status: HTTP_CONFLICT, message: NO_DIRECTORY };
  const workspace = workspaceOf(config, task);
  if ('status' in workspace) return workspace;
  const cwd = taskDir(workspace.path, activity);
  return { cwd, onDisk: true, transcriptCwds: [cwd], label: taskLabel(task) };
}

/** The branch git has checked out at `cwd`; null when detached or unreadable. */
export async function readBranch(cwd: string, exec: Exec): Promise<string | null> {
  try {
    return (await exec('git', ['-C', cwd, 'branch', '--show-current'])).stdout.trim() || null;
  } catch {
    return null; // a directory that is no repo has no branch to show
  }
}

/** How many lines `git status --porcelain` lists at `cwd`; 0 when git fails. */
export async function uncommitted(cwd: string, exec: Exec): Promise<number> {
  try {
    return (await exec('git', ['-C', cwd, 'status', '--porcelain'])).stdout.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

export const noticeSide = (side: CopySide, branch: string | null): string => `${side.label}, branch ${branch ?? '(detached)'}, directory ${side.cwd}`;

export const copyNotice = (from: string, to: string): string => `Hive: this conversation was copied from ${from}. It now continues in ${to}.\n\n${NOTICE_TAIL}`;

/** The directory an activity's runs work in: its task's (workDir) or its workspace's checkout; undefined when neither is known any more. The
 * register compares a held session's folder with its terminal's by it (#347). */
export function activityDir(state: State, config: Pick<Config, 'comb'>, activityId: string): string | undefined {
  const activity = state.activities.find((a) => a.id === activityId);
  if (activity?.kind === 'local') return workspaceByName(config, activity.workspace)?.path;
  const task = taskOfActivity(state, activityId);
  const workspace = task && taskWorkspace(config, task);
  return task && workspace && workDir(workspace.path, task, activity);
}

// The directory a worker's run works in
const workerCwd = (state: State, config: Pick<Config, 'comb'>, worker: Worker): string | undefined =>
  (worker.activityId === undefined ? undefined : activityDir(state, config, worker.activityId));

/** A saved state's copy marks (#587), each kept only when its dir is the transcript dir of its own worker's directory, where the route put the
 * temporary copy: a forged state.json never points the boot's removal at any other file. */
export function trustedCopies(state: State, config: Pick<Config, 'comb'>): State {
  const trusted = (worker: Worker): Worker => {
    const cwd = worker.copyOf === undefined ? undefined : workerCwd(state, config, worker);
    // never the worker's own session: the mark names the source's id, so a from equal to it can only be forged
    if (worker.copyOf === undefined || (cwd !== undefined && worker.copyOf.dir === runners[ranAgent(worker)].transcriptDir(cwd) && worker.copyOf.from !== worker.sessionId)) return worker;
    const { copyOf: _copyOf, ...unmarked } = worker;
    return unmarked;
  };
  return { ...state, workers: state.workers.map(trusted) };
}
