import { useEffect } from 'react';
import { postJson, sendJson } from '../lib/api.js';
import { treeChanged } from '../lib/tree-place.js';

// The daemon drops a lease it has not heard from in 30 s (LEASE_TTL_MS): two renewals may fail before the watch stops
export const LEASE_RENEW_MS = 10_000;
const LEASE_TTL_MS = 30_000; // the daemon's (src/tree-watch.ts): a post later than this found no lease

/** Holds the tree watch's lease while a files sidebar is shown (#502): posted at once and every LEASE_RENEW_MS, deleted when the sidebar hides,
 *  unmounts or switches activity. One lease per shown sidebar, so two windows on one activity hold two. A failed post goes to the console and
 *  the next renewal retries it: the tree still reads on focus and on its own operations, so it is no toast. */
export function useTreeLease(activityId: string, isShown: boolean): void {
  useEffect(() => {
    if (!isShown) return undefined;
    const url = `/activities/${encodeURIComponent(activityId)}/tree/watch`;
    const lease = crypto.randomUUID();
    // A change before the watch started, or while the lease had lapsed (a failed post, a throttled window's late timer), was heard by nobody:
    // the post that (re)creates the lease reads the tree once
    let lastOk = Number.NEGATIVE_INFINITY;
    const post = (): void => {
      postJson(url, { lease }).then(
        () => {
          const isFresh = Date.now() - lastOk > LEASE_TTL_MS;
          lastOk = Date.now();
          if (isFresh) treeChanged(activityId);
        },
        (err: unknown) => { lastOk = Number.NEGATIVE_INFINITY; console.error('tree watch: lease not posted', err); },
      );
    };
    post();
    const timer = setInterval(post, LEASE_RENEW_MS);
    const onVisible = (): void => { if (document.visibilityState === 'visible') post(); };
    window.addEventListener('focus', post);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', post);
      document.removeEventListener('visibilitychange', onVisible);
      sendJson('DELETE', `${url}/${encodeURIComponent(lease)}`).catch((err: unknown) => console.error('tree watch: lease not released', err));
    };
  }, [activityId, isShown]);
}
