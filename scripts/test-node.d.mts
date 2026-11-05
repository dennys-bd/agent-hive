/** Types for scripts/test-node.mjs, which test/test-node.test.ts imports at run time (#624). */
export declare const GLOBS: readonly string[];

export interface TestFilesOptions {
  /** The dist/ folder every path is relative to. */
  root: string;
  /** A list file, one dist/-relative path per line; it replaces the globs. */
  list?: string;
  /** Globs matched against each dist/-relative path; a match is dropped. */
  exclude?: readonly string[];
}

export declare function testFiles(options: TestFilesOptions): string[];
