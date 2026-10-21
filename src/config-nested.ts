import { isAbsolute } from 'node:path';
import type { Workspace } from './types.js';

// A workspace's nested repos (#653), by shape only: git's checks (a top level, ignored, not a submodule) need the disk and run at save time,
// in nested-check.ts. Out of config.ts, which is past 400 lines.

const FILE = 'hive.config.json';
const HIVE = '.hive'; // HIVE_DIR (hooks-settings.ts), spelled here so the config parser imports no protocol module
const LIST = 'must be a list of relative paths';
const SHAPE = 'must be a relative path inside the workspace, with no "..", "." or trailing "/"';

/** Why `path` cannot name a nested repo by its shape (#653), undefined when it can: relative, normalized, never .hive or under it. */
export function nestedPathProblem(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.split('/').some((s) => s === '' || s === '.' || s === '..')) return SHAPE;
  return path === HIVE || path.startsWith(`${HIVE}/`) ? 'cannot be .hive or inside it' : undefined;
}

function parseList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${FILE}: "${field}" ${LIST}`);
  return raw.map((path: unknown, i) => {
    const problem = nestedPathProblem(path);
    if (problem) throw new Error(`${FILE}: "${field}[${i}]" ${problem}`);
    if (raw.indexOf(path) !== i) throw new Error(`${FILE}: "${field}[${i}]" repeats ${String(path)}`);
    return path as string;
  });
}

/** A workspace's nested repos and the paths the user said are not ones (#653): both required, [] for none, no migration, never in both lists. */
export function parseNestedRepos(raw: Record<string, unknown>, field: string): Pick<Workspace, 'nestedRepos' | 'notNestedRepos'> {
  const nestedRepos = parseList(raw.nestedRepos, `${field}.nestedRepos`);
  const notNestedRepos = parseList(raw.notNestedRepos, `${field}.notNestedRepos`);
  const both = notNestedRepos.findIndex((path) => nestedRepos.includes(path));
  if (both !== -1) throw new Error(`${FILE}: "${field}.notNestedRepos[${both}]" is ${notNestedRepos[both]}, which nestedRepos lists`);
  return { nestedRepos, notNestedRepos };
}
