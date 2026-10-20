import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ProjectItem, ProjectView } from '../../types';
import { t } from '@/i18n';

/** What the native view shows (#756): its read in flight, its failure, or the view. */
export type ProjectState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'view'; view: ProjectView };

const HTTP_TOO_MANY_REQUESTS = 429;
const pad = (n: number): string => String(n).padStart(2, '0');

// The quota's reset as local HH:MM; an unreadable one reads empty
function clock(iso: string | undefined): string {
  const at = new Date(iso ?? '');
  return Number.isNaN(at.getTime()) ? '' : `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A read whose 429 carries resetsAt beside its error (#756, #757), which parseJson drops: that refusal in the quota copy with the reset
 * time, any other refusal in its own words. */
export async function readQuotaJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; resetsAt?: string };
  if (res.status === HTTP_TOO_MANY_REQUESTS) throw new Error(t('project.error.quota', { time: clock(body.resetsAt) }));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

// The last view each source answered (#756): what the tab shows at once on reopening, and keeps on screen while a reload reads. Lives as
// long as the window: an app restart reads afresh
const cache = new Map<string, ProjectView>();

/** Tests only: forgets every cached view. */
export function forgetProjects(): void {
  cache.clear();
}

// What the tab shows before a read answers: the cached view, else lendo…
function shown(source: string): ProjectState {
  const cached = cache.get(source);
  return cached === undefined ? { kind: 'loading' } : { kind: 'view', view: cached };
}

/** A source's native view (#756), read when the tab opens and on each reload (atualizar, after an action): never polled. A cached view
 * shows while the read runs and is swapped when it answers; an answer that an older read overtook is dropped. A failure toasts, and is the
 * error state only when nothing is cached; reload never rejects. The open reads what the read model holds (#282); fresh, the refresh button's,
 * has the server read GitHub first. */
export function useProject(source: string): { project: ProjectState; reload(options?: { fresh?: boolean }): Promise<void>; replaceRow(row: ProjectItem): void } {
  const [project, setProject] = useState<ProjectState>(() => shown(source));
  const latest = useRef(0);
  const reload = useCallback(async (options: { fresh?: boolean } = {}): Promise<void> => {
    latest.current += 1;
    const read = latest.current;
    setProject(shown(source));
    try {
      const view = await readQuotaJson<ProjectView>(`/sources/${encodeURIComponent(source)}/project${options.fresh === true ? '?fresh=1' : ''}`);
      if (read !== latest.current) return; // overtaken: a newer read owns both the screen and the cache
      cache.set(source, view);
      setProject({ kind: 'view', view });
    } catch (err) {
      if (read !== latest.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (!cache.has(source)) setProject({ kind: 'error', message });
      toast.error(message);
    }
  }, [source]);
  // #686: a field write's re-read row in place of the loaded one, on screen and in the cache: no read of the whole view
  const replaceRow = useCallback((row: ProjectItem): void => {
    const cached = cache.get(source);
    if (cached === undefined) return;
    const view = { ...cached, items: cached.items.map((item) => (item.itemId === row.itemId ? row : item)) };
    cache.set(source, view);
    setProject({ kind: 'view', view });
  }, [source]);
  useEffect(() => { void reload(); }, [reload]);
  return { project, reload, replaceRow };
}
