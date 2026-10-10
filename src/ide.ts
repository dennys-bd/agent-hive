// Where a path a page sent resolves for an activity (#258, #697): the editor pane's and the preview pane's routes (server-editor.ts) and the
// details panel's result files (server-files.ts). Every OS touch is injected (realpath, isFile), so the tests fake them; node:path is only
// string work. The external IDE that once opened these files is gone (#818).
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { TaskFile } from './types.js';

export interface TaskFileQuery {
  worktree?: string; // taskDir(workspace, task): the task's worktree, or the workspace's checkout (#444); the base while it is on disk; none once the activity is deleted (#629)
  workspace: string; // the task's workspace root: the base once the worktree is gone
  path: string; // what the page or the result holds: relative to the base, or absolute inside it
  realpath(path: string): Promise<string>; // rejects when the path does not exist
  isFile(path: string): Promise<boolean>;
}

/** Strictly below `base`: not the base itself, not `..` or anything past it, not another root. server-move.ts guards a drop with it (#594). */
export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// The folder a relative path resolves against (#258): the worktree while it is on disk, else the workspace root
async function baseFolder({ worktree, workspace, realpath }: Pick<TaskFileQuery, 'worktree' | 'workspace' | 'realpath'>): Promise<{ base: string; onDisk: boolean }> {
  const onDisk = worktree !== undefined && (await realpath(worktree).then(() => true, () => false));
  return { base: onDisk ? worktree : workspace, onDisk };
}

/** Any existing file an activity's routes open (#697), or why there is none. */
export type ActivityPath = { file: string; base: TaskFile['base'] } | { reason: 'missing' };

// Which of the activity's folders holds a real path (#697): the worktree first (it sits inside the workspace), then the workspace, else neither
async function holderOf(real: string, worktree: string | undefined, workspace: string, realpath: TaskFileQuery['realpath']): Promise<TaskFile['base']> {
  const realOf = (folder: string): Promise<string> => realpath(folder).catch(() => folder);
  if (worktree !== undefined && isInside(await realOf(worktree), real)) return 'worktree';
  return isInside(await realOf(workspace), real) ? 'workspace' : 'outside';
}

/** Where an activity's file is for the editor pane and the preview pane (#697): the worktree's (else the workspace's) base and its realpath, then a regular
 *  file anywhere on the disk; no inside check. `file` is the real path, `base` the folder that holds it.
 *  ponytail: any file the user can read or write is reachable through the UI's routes, guarded only by server.ts's origin, DNS-rebinding and
 *  x-hive-ui checks; a single-user local app that already runs the user's shells. An allowlist of roots if the Hive ever serves more than
 *  its own window. */
export async function resolveActivityPath({ worktree, workspace, path, realpath, isFile }: TaskFileQuery): Promise<ActivityPath> {
  const { base, onDisk } = await baseFolder({ worktree, workspace, realpath });
  const real = await realpath(resolve(base, path)).catch(() => undefined);
  if (real === undefined || !(await isFile(real))) return { reason: 'missing' };
  return { file: real, base: await holderOf(real, onDisk ? worktree : undefined, workspace, realpath) };
}
