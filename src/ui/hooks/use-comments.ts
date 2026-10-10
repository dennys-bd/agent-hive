import { useEffect, useState } from 'react';
import type { TaskComment } from '../../types';
import { getJson } from '../lib/api.js';

/** What the details panel shows under the body. `unsupported`: the source has no comments, so the section is hidden. */
export type CommentsState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'list'; comments: TaskComment[] };

/** The selected task's comments, fetched once per selection (not on every poll); a late answer for another task is dropped. */
export function useComments(taskId: string | undefined): CommentsState {
  const [comments, setComments] = useState<CommentsState>({ kind: 'loading' });
  useEffect(() => {
    setComments({ kind: 'loading' });
    if (!taskId) return;
    let live = true;
    getJson<TaskComment[] | null>(`/tasks/${encodeURIComponent(taskId)}/comments`).then(
      (list) => { if (live) setComments(list === null ? { kind: 'unsupported' } : { kind: 'list', comments: list }); },
      (err: unknown) => { if (live) setComments({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [taskId]);
  return comments;
}
