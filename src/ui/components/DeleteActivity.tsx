import { type ReactElement, useId, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { activityOf } from '../../activities';
import { type RemovalBlocker, removalBlocker } from '../../tasks';
import type { State, Task } from '../../types';

/** Why a removal without force was refused (#660): the routes' codes, the UI's own copy of src/worktree-base.ts's union. */
export type Refusal = { reason: 'dirty'; path: string; files: string } | { reason: 'unmerged'; branch: string; target: string } | { reason: 'unexpected' };

/** What both removal routes answer with a 200: removed, or refused with a code this file words (#660). */
export type Removal = { removed: true } | { removed: false; refused: Refusal };

/** What a caller that posts by itself keeps for a post that failed (#660): the server's words are never shown. */
export const UNEXPECTED_REFUSAL: Refusal = { reason: 'unexpected' };

/** A refusal's copy in the user's language (#660); git's own words are in hive.log. */
export function refusalText(refused: Refusal): string {
  switch (refused.reason) {
    case 'dirty': return t('deleteActivity.refused.dirty', { path: refused.path, files: refused.files });
    case 'unmerged': return t('deleteActivity.refused.unmerged', { branch: refused.branch, target: refused.target });
    case 'unexpected': return t('deleteActivity.refused.unexpected');
  }
}

/** The #182 route of a task's live activity (#629): the ⋯ menu and the worktrees tab's task-owned rows both post here (#573). */
export const activityDeletionUrl = (activityId: string): string => `/activities/${encodeURIComponent(activityId)}/delete`;

/** removalBlocker, plus a task with no live activity (#629): the route acts on one, so the menus read nothing to delete; in a delete-activity
 * stage the task's own button (its start) moves such a task on. */
export const deletionBlocker = (task: Task, state: State): RemovalBlocker | undefined =>
  removalBlocker(task, state) ?? (activityOf(state, task.item.itemId) ? undefined : 'nothingToDelete');

/** The delete route of the task's live activity; '' with none, which deletionBlocker keeps every menu from posting. */
export const taskDeletionUrl = (task: Task, state: State): string => {
  const live = activityOf(state, task.item.itemId);
  return live ? activityDeletionUrl(live.id) : '';
};

interface DeleteActivityProps {
  url: string; // the task route (#182) or, for a worktree no task owns, /worktrees/:slug/remove (#181)
  message: string; // the confirm text: what is lost
  title?: string; // the confirm's title; the activity's by default, a worktree no task owns says its own
  available: boolean; // shows the trigger (the Settings row hides it); the popup stays mounted whatever it says
  disabledReason?: string; // set: the default trigger shows disabled, with this reason as its native tooltip; no confirm opens (#210)
  size?: 'sm'; // the default trigger's size; unset keeps the Button default, as the Settings WorktreesTab still wants (#344)
  onDone?(): void; // after every answer (removed, refused, failed): the worktrees tab reloads its list
  trigger?: ReactElement; // replaces the default destructive "delete activity" button (#215's compact row)
  // Set: the caller opens the confirm itself (the detail's ⋯ menu, redesign 06) and no trigger renders; a menu item closes its menu, so it
  // cannot hold a trigger the confirm would unmount with
  confirm?: { open: boolean; onOpenChange(open: boolean): void };
}

/**
 * The delete activity button (#182, #181, #210, #573): it removes the worktree. The confirmed click runs git without force (all or nothing); a refusal,
 * which removed nothing, opens a second confirm (#75) with the refusal's copy (#660) and the warning, where `cancel` (or Escape) keeps everything and `force` (Enter)
 * repeats the request with force. The details panel always shows the trigger and disables it with the reason as a tooltip
 * (`title` on a span: a disabled button fires no pointer events); the Settings row hides it through `available`. The popup is mounted
 * whatever either says: the task route marks the task deleting before git runs and that mark reaches the panel before the answer, so only
 * the trigger follows it; the popup must outlive it. A failure toasts the unexpected error.
 */
export function DeleteActivity({ url, message, title = t('confirm.title.deleteActivity'), available, disabledReason, size, onDone, trigger, confirm }: DeleteActivityProps) {
  const [refused, setRefused] = useState<Refusal>();
  const reasonId = useId();
  const label = t('detail.deleteActivity');
  const remove = (body?: { force: true }): void => {
    postJson<Removal>(url, body)
      .then((answer) => setRefused(answer.removed ? undefined : answer.refused))
      .catch(() => toast.error(t('deleteActivity.failed'))) // #660: never the server's message; git's words are in hive.log
      .finally(() => onDone?.());
  };
  return (
    <>
      {confirm && <Confirm open={confirm.open} onOpenChange={confirm.onOpenChange} title={title} message={message} confirmLabel={label} onConfirm={() => remove()} />}
      {!confirm && available && disabledReason !== undefined && (
        // title shows the reason to the pointer; aria-describedby reads it to a screen reader, which never focuses a disabled button
        <span title={disabledReason} className="self-start">
          <Button type="button" variant="destructive" size={size} disabled aria-describedby={reasonId}>{label}</Button>
          <span id={reasonId} className="sr-only">{disabledReason}</span>
        </span>
      )}
      {!confirm && available && disabledReason === undefined && (
        <Confirm
          title={title}
          message={message}
          confirmLabel={label}
          trigger={trigger ?? <Button type="button" variant="destructive" size={size} className="self-start">{label}</Button>}
          onConfirm={() => remove()}
        />
      )}
      <Confirm
        open={refused !== undefined} onOpenChange={(open) => { if (!open) setRefused(undefined); }}
        title={t('confirm.title.forceDelete')} message={`${refused === undefined ? '' : refusalText(refused)}\n\n${t('confirm.forceDeleteActivity')}`}
        confirmLabel={t('task.force')} onConfirm={() => remove({ force: true })}
      />
    </>
  );
}
