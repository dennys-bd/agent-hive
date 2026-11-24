/** Types for scripts/test-wsl.mjs, which test/test-wsl.test.ts imports at run time (#948). */
export declare const WSL_GLOB: string;

/** The lane's test files under `root`, a dist/-shaped folder: '/'-separated and sorted. */
export declare function wslFiles(root: string): string[];
