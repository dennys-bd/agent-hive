// The merge method a viewer last picked, per repository (#592): hive.mergeMethod, a map owner/repo → method. A viewer's habit, like
// hive.diffLayout, never a setting.
import { MERGE_METHODS } from '../../pr-github.js';
import type { MergeMethod } from '../../types.js';

export const MERGE_METHOD_KEY = 'hive.mergeMethod';

/** owner/repo of a PR link (#592). */
export const repoOf = (url: string): string => new URL(url).pathname.split('/').slice(1, 3).join('/');

// What the key holds, or nothing: a hand edit or another build's value never breaks mergear
function stored(storage: Storage): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage.getItem(MERGE_METHOD_KEY) ?? '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The method mergear uses (#592): the one remembered for the repository while it still allows it, else the first allowed in MERGE_METHODS. */
export function pickMethod(url: string, allowed: readonly MergeMethod[], storage: Storage = localStorage): MergeMethod | undefined {
  const remembered = stored(storage)[repoOf(url)];
  const kept = allowed.find((method) => method === remembered);
  return kept ?? MERGE_METHODS.find((method) => allowed.includes(method));
}

export function rememberMethod(url: string, method: MergeMethod, storage: Storage = localStorage): void {
  storage.setItem(MERGE_METHOD_KEY, JSON.stringify({ ...stored(storage), [repoOf(url)]: method }));
}
