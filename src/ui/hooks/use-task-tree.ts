import { useEffect, useState } from 'react';
import type { TaskTree } from '../../types';
import { getJson } from '../lib/api.js';
import { onTreeChanged, rememberRoot } from '../lib/tree-place.js';

// ponytail: a poll stands in for a watch; a push from the daemon (fs.watch on the worktree) when the lag or the git runs ever matter
const POLL_MS = 3000;

export type TreeState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; tree: TaskTree };

/** A task's worktree for the files sidebar (redesign 07): read when shown, then every POLL_MS while it stays shown, so it follows git
 *  status; a hidden sidebar runs no git. A late answer after the sidebar hid is dropped;
 *  its caller is keyed by task, so a new task starts loading. */
export function useTaskTree(activityId: string, isShown: boolean): TreeState {
  const [state, setState] = useState<TreeState>({ status: 'loading' });
  useEffect(() => {
    if (!isShown) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let isReading = false;
    let isAgain = false; // a change while a read flew: the next read goes as soon as that one settles
    // The next read is armed once this one settles: a slow git never piles reads up nor lets an older answer land last
    const read = (): void => {
      if (isReading) {
        isAgain = true;
        return;
      }
      isReading = true;
      getJson<TaskTree>(`/activities/${encodeURIComponent(activityId)}/tree`).then(
        (tree) => { if (live) { rememberRoot(activityId, tree.root); setState({ status: 'ready', tree }); } },
        // a failed poll keeps the tree it had: only a sidebar with none yet shows the error
        (err: unknown) => { if (live) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: err instanceof Error ? err.message : String(err) })); },
      ).finally(() => {
        isReading = false;
        if (!live) return;
        if (isAgain) {
          isAgain = false;
          read();
        } else timer = setTimeout(read, POLL_MS);
      });
    };
    read();
    const stop = onTreeChanged(activityId, () => { clearTimeout(timer); read(); }); // #818: an operation the server took shows at once
    return () => { live = false; clearTimeout(timer); stop(); };
  }, [activityId, isShown]);
  return state;
}
