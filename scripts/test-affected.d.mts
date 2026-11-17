/** Types for scripts/test-affected.mjs, which test/test-affected.test.ts imports at run time (#867). */
export interface SelectOptions {
  /** The repo root the changed paths are relative to. */
  repo: string;
  /** The dist/ folder the compiled tests live in. */
  root: string;
  /** Repo-relative paths changed on the branch. */
  changed: readonly string[];
}

/** `full` names the changed file that makes the import graph blind; `files` are dist/-relative tests. */
export type Selection = { full: string } | { files: string[] };

export declare function selectTests(options: SelectOptions): Selection;
export declare function changedFiles(git: (args: readonly string[]) => string): { base: string | null; files: string[] };
export declare function workers(cores: number): number;
