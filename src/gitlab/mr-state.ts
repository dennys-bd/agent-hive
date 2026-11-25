import type { PrState } from '../types.js';

/** A merge request's `state` as the Hive's PR state; `locked` is a merge in flight, still open. Unknown is undefined: the caller decides, never a guess. */
export function mrState(state: string): PrState | undefined {
  switch (state) {
    case 'opened':
    case 'locked':
      return 'open';
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    default:
      return undefined;
  }
}
