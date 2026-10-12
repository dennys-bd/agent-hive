import { useEffect, useState } from 'react';
import type { TaskTree } from '../../types';
import { getJson } from '../lib/api.js';
import type { TreeState } from './use-task-tree.js';

/** The open activity's tree for the search (#133): read once when the search opens, never polled; a failure is the route's to log (http.error
 *  in hive.log). Undefined with no activity open, and then nothing is read. An answer after the search closed is dropped. */
export function useSearchFiles(activityId: string | undefined): TreeState | undefined {
  const [state, setState] = useState<TreeState>({ status: 'loading' });
  useEffect(() => {
    if (activityId === undefined) return undefined;
    let live = true;
    getJson<TaskTree>(`/activities/${encodeURIComponent(activityId)}/tree`).then(
      (tree) => { if (live) setState({ status: 'ready', tree }); },
      (err: unknown) => { if (live) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [activityId]);
  return activityId === undefined ? undefined : state;
}
