// Settings › workspaces › nested repos' pure edges (#653): the draft's rows, and (Task 7) the old setup line.

/** A nested repo's row: id is its React key, never sent; the path as typed. */
export interface NestedRepoDraft { id: string; path: string }

/** The rows' paths as a save sends them: trimmed, a blank row (a `+ nested repo` not typed in yet) left out. */
export const nestedPaths = (row: { nestedRepos: readonly NestedRepoDraft[] }): string[] =>
  row.nestedRepos.map((r) => r.path.trim()).filter((path) => path !== '');

const EDGE = '[\\s/"\'=]'; // what can stand around a path segment in a shell line
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const segment = (path: string): RegExp => new RegExp(`(?:^|${EDGE})${escaped(path)}(?:$|${EDGE})`);

/** The nested path a setup RUN line still adds a worktree on (#653), which the Hive now adds before the setup, so that step would fail;
 * undefined when none does. A whole path segment only: `docs` never matches `docsite`. LOAD files are not read, as the save does not. */
export function oldSetupPath(setup: string, nested: readonly string[]): string | undefined {
  const runs = setup.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('RUN ') && line.includes('worktree add'));
  return nested.find((path) => runs.some((line) => segment(path).test(line)));
}
