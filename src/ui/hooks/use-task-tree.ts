import { useEffect, useState } from 'react';
import type { TaskTree } from '../../types';
import { getJson } from '../lib/api.js';
import { isTreeRead } from '../lib/tree-change.js';
import { onTreeEvent } from '../lib/tree-events.js';
import { onTreeChanged, rememberRoot } from '../lib/tree-place.js';

export type TreeState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; tree: TaskTree };

/** A task's worktree for the files sidebar (redesign 07): read when shown, then on each `tree` event of its activity whose paths reach the
 *  tree (#502), on each window focus and after each tree operation (#818); a hidden sidebar reads nothing, and an idle tree runs no git.
 *  A late answer after the sidebar hid is dropped; its caller is keyed by task, so a new task starts loading. */
export function useTaskTree(activityId: string, isShown: boolean): TreeState {
  const [state, setState] = useState<TreeState>({ status: 'loading' });
  useEffect(() => {
    if (!isShown) return undefined;
    let live = true;
    let isReading = false;
    let isAgain = false; // a change while a read flew: the next read goes as soon as that one settles
    let last: TaskTree | undefined; // the event rule reads the last answer's ignored entries
    // One read at a time: a slow git never piles reads up nor lets an older answer land last
    const read = (): void => {
      if (isReading) {
        isAgain = true;
        return;
      }
      isReading = true;
      getJson<TaskTree>(`/activities/${encodeURIComponent(activityId)}/tree`).then(
        (tree) => { if (live) { last = tree; rememberRoot(activityId, tree.root); setState({ status: 'ready', tree }); } },
        // a failed read keeps the tree it had: only a sidebar with none yet shows the error
        (err: unknown) => { if (live) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: err instanceof Error ? err.message : String(err) })); },
      ).finally(() => {
        isReading = false;
        if (live && isAgain) {
          isAgain = false;
          read();
        }
      });
    };
    read();
    const stops = [
      onTreeChanged(activityId, read), // #818: an operation the server took shows at once
      onTreeEvent((change) => { if (change.activityId === activityId && isTreeRead(change.paths, last?.ignored)) read(); }), // #502
    ];
    window.addEventListener('focus', read);
    return () => { live = false; for (const stop of stops) stop(); window.removeEventListener('focus', read); };
  }, [activityId, isShown]);
  return state;
}
