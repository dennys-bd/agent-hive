import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { IssuePage } from '../../types';
import { readQuotaJson } from '@/hooks/use-project';
import { useReadModelReload } from '@/hooks/use-repo-issues';
import { repoPath } from '@/hooks/use-repositories';

/** What the issue page shows (#757): its first read in flight, its failure with nothing shown, or the issue. */
export type IssueLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'issue'; issue: IssuePage };

/** An issue's route (#757). */
export const issuePath = (repository: string, number: number): string => `${repoPath(repository)}/issues/${number}`;

// The event names only the repository, never the issue: any issue or comment change of it reads the page again, a local read (#182)
const PAGE_KINDS: readonly string[] = ['issues', 'comments'];

/** One issue's page (#757): read on opening and on each reload (atualizar, after a write); never polled. A reload keeps the issue shown until
 * its answer replaces it, so a draft beside it survives; a failure toasts and, with nothing shown yet, is the error state. Never rejects.
 * Read again on its repository's issue or comment changes (#182). */
export function useIssue(repository: string, number: number): { load: IssueLoad; reload(): Promise<void> } {
  const [load, setLoad] = useState<IssueLoad>({ kind: 'loading' });
  const latest = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const read = latest.current;
    try {
      const issue = await readQuotaJson<IssuePage>(issuePath(repository, number));
      if (read === latest.current) setLoad({ kind: 'issue', issue });
    } catch (err) {
      if (read !== latest.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setLoad((current) => (current.kind === 'issue' ? current : { kind: 'error', message }));
      toast.error(message);
    }
  }, [repository, number]);
  useEffect(() => { void reload(); }, [reload]);
  useReadModelReload(repository, PAGE_KINDS, reload);
  return { load, reload };
}
