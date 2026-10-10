import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';

/** One row of GET /activities/worktrees (#586): the files the task's worktree has changed and its commits ahead of the diff's base. */
export interface WorktreeState { itemId: string; changed: number; ahead: number }

/** The worktree line's state (#586): ±changed and ↑ahead, joined, each only when not zero, or limpa when both are. */
export function worktreeText({ changed, ahead }: WorktreeState): string {
  const parts = [changed > 0 ? `±${changed}` : '', ahead > 0 ? `↑${ahead}` : ''].filter((part) => part !== '');
  return parts.length === 0 ? t('activities.clean') : parts.join(' · ');
}

/** Each activity's worktree state by task, read while `isShown` holds and again whenever `key` changes, as useBranches does: the tab keys it
 * by its activities and their statuses, since a Stop is when a worktree changes. A failed read leaves the lines without a state. */
export function useWorktreeStates(isShown: boolean, key: string): Record<string, WorktreeState> {
  const [states, setStates] = useState<Record<string, WorktreeState>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the trigger of a new read, not a value it uses
  useEffect(() => {
    if (!isShown) return;
    let isStale = false; // a newer read (or an unmount) started: this answer is dropped, so an older one never lands last
    getJson<WorktreeState[]>('/activities/worktrees')
      .then((rows) => { if (!isStale) setStates(Object.fromEntries(rows.map((row) => [row.itemId, row]))); })
      .catch(() => { if (!isStale) setStates({}); });
    return () => { isStale = true; };
  }, [isShown, key]);
  return states;
}
