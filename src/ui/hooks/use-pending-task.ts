import { useEffect, useState } from 'react';
import type { Task } from '../../types';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

/** A task the Start dialog creates on a source (#846): only a title and a destination until the activity starts. */
export interface HeldTask { title: string; source: string }
type CreateAnswer = { id: string; itemId: string } | { itemId: string; notice: string };

/** The held entry, its create through POST /tasks with its source at the start, and the task it became, awaited until the state holds it. The
 * entry goes with its create, whatever the answer, so a second start never creates the issue twice; a notice or an error is the dialog's line. */
export function usePendingTask(stage: string | undefined, onError: (message: string) => void) {
  const [entry, setEntry] = useState<HeldTask>();
  const [awaiting, setAwaiting] = useState<string>();
  const create = (): Promise<string | undefined> => {
    if (entry === undefined) return Promise.resolve(undefined);
    setEntry(undefined);
    return postJson<CreateAnswer>('/tasks', { title: entry.title, stage, auto: false, source: entry.source }).then((answer) => {
      if ('notice' in answer) return void onError(t('start.notInFlow', { source: entry.source }));
      setAwaiting(answer.itemId);
      return answer.itemId;
    }, (err: Error) => void onError(err.message));
  };
  return { entry, hold: setEntry, create, awaiting, clearAwaiting: () => setAwaiting(undefined) };
}

/** The start of the task a held entry became, as soon as the state holds it and nothing blocks it (bases read, a workspace chosen) (#846). */
export function useAutoStart(awaiting: string | undefined, task: Task | undefined, isBlocked: boolean, start: () => void): void {
  useEffect(() => {
    if (awaiting !== undefined && task?.item.itemId === awaiting && !isBlocked) start();
  });
}
