import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ReviewFile } from '../../types';
import { getJson } from '../lib/api.js';
import { onReviewEvent } from '@/lib/review-events';
import { isReviewFile } from '@/lib/review-view';

/** A task's review file for its diff pane (#591): read on mount, on every review event of the task, and on refresh(). Only the latest read lands. */
export function useReview(taskId: string): { review?: ReviewFile; refresh(): void } {
  // Kept with the task it was read for: another task's pane never shows this one's file while its own read is out
  const [loaded, setLoaded] = useState<{ taskId: string; file: ReviewFile }>();
  const latest = useRef(0);
  const refresh = useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    getJson<unknown>(`/tasks/${encodeURIComponent(taskId)}/review`).then(
      (file) => { if (latest.current === mine && isReviewFile(file)) setLoaded({ taskId, file }); },
      (err: Error) => toast.error(err.message),
    );
  }, [taskId]);
  useEffect(() => {
    refresh();
    return onReviewEvent((id) => { if (id === taskId) refresh(); });
  }, [taskId, refresh]);
  return { review: loaded?.taskId === taskId ? loaded.file : undefined, refresh };
}
