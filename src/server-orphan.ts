import { activityOf } from './activities.js';
import { type LiveView, placedTask, type TaskRouteDeps, workspaceOf } from './server-tasks.js';
import { branchFor, slugFor } from './tasks.js';
import { DISCARD_FAILED } from './types.js';
import { cleanWorktree } from './worktree.js';

// The start dialog's discard (#861), out of server-tasks.ts, which is past 400 lines: what git holds for a task with no activity goes before its
// start, so its worktree is made again from the chosen base.

const HTTP_CONFLICT = 409;

/** A refused discard's answer: git's words and DISCARD_FAILED. */
export interface DiscardRefusal { status: number; error: string; code: typeof DISCARD_FAILED }

/** With `discardOrphan: true` on a task with no activity: the slug's worktree and the task's branch go as delete activity's git removes them
 * (cleanWorktree, never forced); with no worktree, the branch alone. Undefined when not asked, with no workspace (startEvent answered that) or
 * once git removed them. */
export async function discardOrphan(deps: Pick<TaskRouteDeps, 'exec'>, current: LiveView, itemId: string, body: unknown): Promise<DiscardRefusal | undefined> {
  const { discardOrphan: asked, workspace: raw } = (body ?? {}) as { discardOrphan?: unknown; workspace?: unknown };
  const found = current.state.tasks.find((c) => c.item.itemId === itemId);
  if (asked !== true || found === undefined || activityOf(current.state, itemId) !== undefined) return undefined;
  const task = placedTask(current.state, found, raw);
  const workspace = 'status' in task ? task : workspaceOf(current.runtime.config, task, current.state.tasks);
  if ('status' in workspace) return undefined;
  const branch = branchFor(current.runtime.config, found.item);
  try {
    await cleanWorktree(workspace.path, { slug: slugFor(found.item), branch }, branch, deps.exec);
    return undefined;
  } catch (err) {
    return { status: HTTP_CONFLICT, error: err instanceof Error ? err.message : String(err), code: DISCARD_FAILED };
  }
}
