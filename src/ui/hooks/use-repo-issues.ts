import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RepoIssues } from '../../types';
import { readQuotaJson } from '@/hooks/use-project';
import { repoPath } from '@/hooks/use-repositories';

// The last answer of each route, for the page's life (#757, #758): a list opened again shows at once, then reads again
const cache = new Map<string, unknown>();

/** One of a repository's lists (#757, #758), read on opening, on a path change and on each reload (atualizar); never polled. The cached
 * answer shows meanwhile; a failure keeps it and toasts, and an answer an older read overtook is dropped. reload never rejects. */
export function useRepoRead<T>(path: string): { data?: T; isLoading: boolean; reload(): Promise<void> } {
  const [held, setHeld] = useState<{ path: string; data?: T }>(() => ({ path, data: cache.get(path) as T | undefined }));
  const [isLoading, setIsLoading] = useState(false);
  const latest = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const read = latest.current;
    setHeld({ path, data: cache.get(path) as T | undefined });
    setIsLoading(true);
    try {
      const answer = await readQuotaJson<T>(path);
      cache.set(path, answer);
      if (read === latest.current) setHeld({ path, data: answer });
    } catch (err) {
      if (read === latest.current) toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (read === latest.current) setIsLoading(false);
    }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  // a held answer of another path is not shown for the render before the effect swaps it
  return { data: held.path === path ? held.data : (cache.get(path) as T | undefined), isLoading, reload };
}

/** A repository's issues in one state (#757). */
export function useRepoIssues(repository: string, state: RepoIssues['state']): { issues?: RepoIssues; isLoading: boolean; reload(): Promise<void> } {
  const { data, isLoading, reload } = useRepoRead<RepoIssues>(`${repoPath(repository)}/issues?state=${state}`);
  return { issues: data, isLoading, reload };
}

/** Tests only: no list read yet. */
export function resetRepoIssues(): void {
  cache.clear();
}
