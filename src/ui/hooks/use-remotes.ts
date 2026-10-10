import { useEffect, useState } from 'react';
import type { GitRemote } from '../../types';
import { getJson } from '@/lib/api';

/** A workspace folder's git remotes (#854), from GET /settings/remotes, read again when the folder changes; none while it is empty, not a
 * repository's top level, or the read fails. Anything but a list reads as none. */
export function useRemotes(path: string): GitRemote[] {
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  useEffect(() => {
    const folder = path.trim();
    if (folder === '') {
      setRemotes([]);
      return undefined;
    }
    let live = true;
    getJson<unknown>(`/settings/remotes?${new URLSearchParams({ path: folder })}`).then(
      (read) => { if (live) setRemotes(Array.isArray(read) ? (read as GitRemote[]) : []); },
      () => { if (live) setRemotes([]); },
    );
    return () => { live = false; };
  }, [path]);
  return remotes;
}
