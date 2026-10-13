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

/** A change shown over the loaded issue until its write settles (#183). */
export type IssuePatch = (issue: IssuePage) => IssuePage;

/** Shows `patch` at once; the returned settle drops it: after the reload on success, at once on a refusal (#183). */
export type Optimistic = (patch: IssuePatch) => () => void;

/** One issue's page (#757): read on opening and on each reload (atualizar, after a write); never polled. A reload keeps the issue shown until
 * its answer replaces it, so a draft beside it survives; a failure toasts and, with nothing shown yet, is the error state. Never rejects.
 * Read again on its repository's issue or comment changes (#182). A write's optimistic patch shows over it until the write settles (#183). */
export function useIssue(repository: string, number: number): { load: IssueLoad; reload(): Promise<void>; optimistic: Optimistic } {
  const [load, setLoad] = useState<IssueLoad>({ kind: 'loading' });
  const [pending, setPending] = useState<readonly { patch: IssuePatch }[]>([]);
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
  // An entry of its own: the same patch sent twice is two writes, each settled once
  const optimistic = useCallback<Optimistic>((patch) => {
    const entry = { patch };
    setPending((current) => [...current, entry]);
    return () => setPending((current) => current.filter((e) => e !== entry));
  }, []);
  // Applied over the loaded issue, never stored in it: a reload or a readModel event during a write replaces the issue, not the patch
  const shown: IssueLoad = load.kind === 'issue' && pending.length > 0
    ? { kind: 'issue', issue: pending.reduce((issue, entry) => entry.patch(issue), load.issue) }
    : load;
  return { load: shown, reload, optimistic };
}
