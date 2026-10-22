// The state stream's tree events (#502): a leased tree changed. useHiveState's one EventSource hears them; each shown files sidebar listens
// here, keeps its own activity's, and decides what to read again.
import type { TreeChange } from '../../types.js';

const listeners = new Set<(change: TreeChange) => void>();

export const onTreeEvent = (listener: (change: TreeChange) => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const emitTreeEvent = (change: TreeChange): void => {
  for (const listener of listeners) listener(change);
};
