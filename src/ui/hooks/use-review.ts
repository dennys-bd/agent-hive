import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ReviewFile } from '../../types';
import { getJson } from '../lib/api.js';
import { onReviewEvent, type ReviewKey } from '@/lib/review-events';
import { isReviewFile } from '@/lib/review-view';

/** A review file (#591): a task's, or a workspace's local one (#345), named by its key. Read on mount, on every review event of that key,
 * and on refresh(). Only the latest read lands. */
export function useReview(key: ReviewKey): { review?: ReviewFile; refresh(): void } {
  // Kept with the key it was read for: another review's pane never shows this one's file while its own read is out
  const [loaded, setLoaded] = useState<{ key: ReviewKey; file: ReviewFile }>();
  const latest = useRef(0);
  const refresh = useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    getJson<unknown>(`${key}/review`).then(
      (file) => { if (latest.current === mine && isReviewFile(file)) setLoaded({ key, file }); },
      (err: Error) => toast.error(err.message),
    );
  }, [key]);
  useEffect(() => {
    refresh();
    return onReviewEvent((changed) => { if (changed === key) refresh(); });
  }, [key, refresh]);
  return { review: loaded?.key === key ? loaded.file : undefined, refresh };
}
