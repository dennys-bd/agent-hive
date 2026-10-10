import { useCallback, useEffect, useRef, useState } from 'react';
import type { BaseOptions } from '../../types';
import { getJson } from '@/lib/api';

/** Where a start puts the task's worktree (#131, #179, #444): the lists GET /tasks/:id/bases answered, the base chosen, the workspace a task no
 * rule places was given, the local-checkout switch, and whether a task base's worker is told of the stacked PR (#217). No lists yet:
 * nothing to ask, as for a task that already has its worktree. */
export interface BaseChoice { lists?: BaseOptions; chosen: string; workspace?: string; local: boolean; tellWorker: boolean }

const EMPTY: BaseChoice = { chosen: '', local: false, tellWorker: true };
const basesUrl = (itemId: string, workspace?: string): string =>
  `/tasks/${encodeURIComponent(itemId)}/bases${workspace === undefined ? '' : `?${new URLSearchParams({ workspace: workspace })}`}`;

/** The other task the chosen base is the branch of, if any: a PR stacked on that task's (redesign 11). */
export const stackedOn = ({ lists, chosen }: BaseChoice): BaseOptions['tasks'][number] | undefined => lists?.tasks.find((c) => c.ref === chosen);

/** The body a start or an open posts for it: nothing once the task has its worktree, else the base (null for the default), the stacked-PR
 * switch on a task base (an open ignores it: a session gets no stage prompt to tell), the local switch and the workspace once chosen. */
export function baseBody(choice: BaseChoice): Record<string, unknown> {
  const { lists, chosen, workspace, local, tellWorker } = choice;
  if (lists === undefined || lists.hasWorktree) return {};
  return {
    base: chosen === lists.defaultRef ? null : chosen,
    ...(stackedOn(choice) === undefined ? {} : { tellWorker }),
    local,
    ...(workspace === undefined ? {} : { workspace: workspace }),
  };
}

/** The base of the picked task (redesign 11), read again whenever the pick changes; a failed read goes to `onError`, the dialog's line. */
export function useStartBase(itemId: string | undefined, onError: (message: string) => void) {
  const [choice, setChoice] = useState<BaseChoice>(EMPTY);
  const current = useRef(itemId); // an answer for a task no longer picked is dropped
  current.current = itemId;
  const read = useCallback((id: string, workspace?: string): void => {
    getJson<BaseOptions>(basesUrl(id, workspace)).then(
      (lists) => { if (current.current === id) setChoice({ ...EMPTY, lists, chosen: lists.defaultRef, ...(workspace === undefined ? {} : { workspace }) }); },
      (err: Error) => { if (current.current === id) onError(err.message); },
    );
  }, [onError]);
  useEffect(() => {
    setChoice(EMPTY);
    if (itemId !== undefined) read(itemId);
  }, [itemId, read]);
  const pickWorkspace = (workspace: string | undefined): void => {
    if (itemId !== undefined && workspace !== undefined) read(itemId, workspace);
  };
  return { choice, setChoice, pickWorkspace };
}
