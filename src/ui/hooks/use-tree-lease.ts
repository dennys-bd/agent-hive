import { useEffect } from 'react';
import { postJson, sendJson } from '../lib/api.js';

// The daemon drops a lease it has not heard from in 30 s (LEASE_TTL_MS): two renewals may fail before the watch stops
export const LEASE_RENEW_MS = 10_000;

/** Holds the tree watch's lease while a files sidebar is shown (#502): posted at once and every LEASE_RENEW_MS, deleted when the sidebar hides,
 *  unmounts or switches activity. One lease per shown sidebar, so two windows on one activity hold two. A failed post goes to the console and
 *  the next renewal retries it: the tree still reads on focus and on its own operations, so it is no toast. */
export function useTreeLease(activityId: string, isShown: boolean): void {
  useEffect(() => {
    if (!isShown) return undefined;
    const url = `/activities/${encodeURIComponent(activityId)}/tree/watch`;
    const lease = crypto.randomUUID();
    const post = (): void => { postJson(url, { lease }).catch((err: unknown) => console.error('tree watch: lease not posted', err)); };
    post();
    const timer = setInterval(post, LEASE_RENEW_MS);
    return () => {
      clearInterval(timer);
      sendJson('DELETE', `${url}/${encodeURIComponent(lease)}`).catch((err: unknown) => console.error('tree watch: lease not released', err));
    };
  }, [activityId, isShown]);
}
