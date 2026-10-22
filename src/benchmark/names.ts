// The benchmark's names a worker must not read as a benchmark's (#105, #463), and the seed's upload name (#459). Node-free: the UI's config
// tab shows the real names instead of copying them; git.ts and store.ts re-export them for the server.

/** What the code baseline drops (#105, the user): the harness and its tests. */
export const EXPERIMENT_PATHS = ['scripts/experiment', 'test/experiment'] as const;
export const taskBranchPrefix = (prefix: string): string => `hive/${prefix}-`;
export const runBranch = (token: string): string => `work/${token}`;
export const runPrefix = (token: string): string => token.toUpperCase();

export const UPLOAD_PREFIX = 'upload:'; // `:` never starts a repo path, so an upload never collides with one
export const UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
