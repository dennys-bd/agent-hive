// A terminal's task references (#588), resolved on the daemon's own State: pure, so node:test covers it; server-files.ts's open-ref routes
// call it, and the terminal side (xterm-setup.ts) reads its RefTarget as the routes' answer.
import type { State, Task } from './types.js';

/** Where a task reference's click goes (#588): the panel of a task the Hive holds, or the issue on GitHub. */
export type RefTarget = { taskId: string } | { url: string };

/** What the open-ref routes take (#588): `#N`, or `PREFIX-N` with a prefix shaped as a COMB_PREFIX or a source's name (WORKSPACE_NAME). */
export const TASK_REF = /^(?:#\d+|[A-Za-z0-9][A-Za-z0-9._-]{0,39}-\d+)$/;

// The issue a task's URL names (…/issues/N). With qualifyId a source's item.id is PREFIX-N, so #N never reads the id
const ISSUE_URL = /\/issues\/(\d+)(?:[/?#]|$)/;
const issueOf = (task: Task): string | undefined => ISSUE_URL.exec(task.item.url)?.[1];
// GitHub sets facets.repository today; a later source or a hand-edited state could put a path or query in it, so the URL gets owner/name only
export const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

// A GitHub origin, https (a token in it included) or ssh, with or without .git
const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)((?!\.+\/)[\w.-]+\/(?!\.+(?:\.git)?\/?$)[\w.-]+?)(?:\.git)?\/?$/;

/** The owner/name of a GitHub remote URL, undefined for any other (#588): what a terminal with no repository of its own falls back to. */
export const githubRepository = (remote: string): string | undefined => GITHUB_REMOTE.exec(remote)?.[1];

/** The target of `ref` seen from a terminal of `repository` (owner/name; absent for a workspace shell or a local task):
 * - `PREFIX-N`: the task whose item.id it is, exactly. No fallback: the id is the Hive's own, there is no issue behind it.
 * - `#N`: a task of issue N in `repository`, else the only task of issue N in the Hive, else issue N on GitHub in `repository`. Two or more
 *   elsewhere pick none: there is no picker. */
export function resolveRef(state: Pick<State, 'tasks'>, ref: string, repository?: string): RefTarget | undefined {
  if (!ref.startsWith('#')) {
    const task = state.tasks.find((t) => t.item.id === ref);
    return task ? { taskId: task.item.itemId } : undefined;
  }
  const issue = ref.slice(1);
  const matches = state.tasks.filter((t) => issueOf(t) === issue);
  const own = repository === undefined ? undefined : matches.find((t) => t.item.facets?.repository === repository);
  const task = own ?? (matches.length === 1 ? matches[0] : undefined);
  if (task) return { taskId: task.item.itemId };
  return repository === undefined || !REPOSITORY.test(repository) ? undefined : { url: `https://github.com/${repository}/issues/${issue}` };
}
