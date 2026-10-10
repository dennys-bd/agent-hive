import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { TaskFile } from '../../types';
import { getJson } from '../lib/api.js';

/** The files of the selected task's result that the details panel links (#258), fetched once per selection like the comments and again
 *  whenever `resultKey` (the task's result, serialised) changes, so a stage's new result shows without reselecting (#662). None while the
 *  first answer for an activity loads, with no workspace (the route answers []); a refetch keeps the current list until it lands.
 *  A failure toasts and keeps what is listed. A late answer for a superseded request is dropped. */
export function useTaskFiles(activityId: string | undefined, resultKey: string): TaskFile[] {
  // The list remembers whose it is, so another activity's list is never shown while its own loads
  const [owned, setOwned] = useState<{ id: string; files: TaskFile[] } | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resultKey is the trigger of a new read, not a value it uses
  useEffect(() => {
    if (!activityId) return;
    let live = true;
    getJson<TaskFile[]>(`/activities/${encodeURIComponent(activityId)}/files`).then(
      (files) => { if (live) setOwned({ id: activityId, files }); },
      (err: unknown) => { if (live) toast.error(err instanceof Error ? err.message : String(err)); },
    );
    return () => { live = false; };
  }, [activityId, resultKey]);
  return owned !== undefined && owned.id === activityId ? owned.files : [];
}
