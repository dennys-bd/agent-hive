// Settings › workspaces › nested repos' pure edges (#653): the draft's rows, and (Task 7) the old setup line.

/** A nested repo's row: id is its React key, never sent; the path as typed. */
export interface NestedRepoDraft { id: string; path: string }

/** The rows' paths as a save sends them: trimmed, a blank row (a `+ nested repo` not typed in yet) left out. */
export const nestedPaths = (row: { nestedRepos: readonly NestedRepoDraft[] }): string[] =>
  row.nestedRepos.map((r) => r.path.trim()).filter((path) => path !== '');
