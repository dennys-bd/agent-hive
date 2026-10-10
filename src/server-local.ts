import type { Activity, BaseOptions, TaskBase } from './types.js';

// The request side of a task run in its workspace's own checkout, local (#444, #573), apart from server-tasks.ts, which is over its size.

/** The delete-activity route's 409 on a local task: there is no worktree, and its branch is the one the user's checkout holds. */
export const LOCAL_MESSAGE = 'tarefa executa no checkout do workspace: não há worktree para excluir';

/** What GET /tasks/:id/bases answers for a local task: where it runs is decided, so neither popup reopens and a start goes straight
 * through, as for a task whose worktree exists. */
export const LOCAL_BASES: BaseOptions = { hasWorktree: true, defaultRef: '', tasks: [], local: [], remote: [] };

/** The start body's switch: only a literal true is on and any other value off; absent (no popup) keeps the task's own. */
export function localOf(body: unknown): { local?: boolean } {
  const { local } = (body ?? {}) as { local?: unknown };
  return local === undefined ? {} : { local: local === true };
}

/** The start route's switch: taken only while the task's activity has no place to run yet, which is when the popup opens. On a task whose worktree
 * exists it would orphan that worktree (no popup and no delete activity would reach it again), and a local task keeps its choice. */
export function startLocal(body: unknown, activity: Pick<Activity, 'worktree' | 'worktreeGone' | 'local'> | undefined): { local?: boolean } {
  return activity?.local || (activity?.worktree !== undefined && !activity.worktreeGone) ? {} : localOf(body);
}

/** Where POST /open's first run goes: the popup's switch and base when the body carries the switch (the popup always sends it); with no
 * popup, which a local task never gets, the task's own choice and its saved base. */
export function openPlace(body: unknown, activity: Pick<Activity, 'local' | 'base'> | undefined): { local: boolean; base?: TaskBase } {
  const { base } = (body ?? {}) as { base?: unknown };
  const { local } = localOf(body);
  if (local === undefined && activity?.local) return { local: true, ...(activity.base ? { base: activity.base } : {}) };
  return { local: local === true, ...(typeof base === 'string' ? { base: { ref: base, tellWorker: false } } : {}) };
}
