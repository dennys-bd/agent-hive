import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskDiff, DiffScope } from '../../types';
import { getJson } from '../lib/api.js';

/** What a diff tab shows (#270): its fetch in flight, the route's error, or the diff. */
export type DiffState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; diff: TaskDiff };

/** A task's diff for the panel's diff tab (#270): fetched each time the tab is shown (it opens shown) and on refresh(), never while hidden,
 * so the text never moves under a reader and a hidden tab runs no git. Only the latest fetch lands: an earlier, slower answer is dropped. */
export function useTaskDiff(activityId: string, scope: DiffScope, active: boolean): { state: DiffState; refresh(): void } {
  const [state, setState] = useState<DiffState>({ status: 'loading' });
  const latest = useRef(0);
  const refresh = useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    setState({ status: 'loading' });
    getJson<TaskDiff>(`/activities/${encodeURIComponent(activityId)}/diff?scope=${scope}`).then(
      (diff) => { if (latest.current === mine) setState({ status: 'ready', diff }); },
      (err: unknown) => { if (latest.current === mine) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }); },
    );
  }, [activityId, scope]);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  return { state, refresh };
}
