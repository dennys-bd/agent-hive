import { useState } from 'react';
import { MoreHorizontalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { activityOf } from '../../activities';
import { nothingToDelete, } from '../../tasks';
import type { Task, State } from '../../types';
import { act } from '@/components/actions';
import { DETAIL_OUTLINE } from '@/components/ApprovalActions';
import { DROPDOWN_KIT, type MenuKit } from '@/components/menu-kit';
import { DeleteActivity, deletionBlocker, taskDeletionUrl } from '@/components/DeleteActivity';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { t } from '@/i18n';

const SCOPE_PARTS = ['session', 'transcripts'] as const;

// The confirm of delete activity (#236, #573): the worktree, its branch and its terminals always go, then what the scope adds. A task with none
// of it (the item is enabled then only in a delete-activity stage) just moves on, and the confirm says so.
export function deleteActivityMessage(task: Task, state: Pick<State, 'deleteActivity' | 'activities' | 'activityRecords'>): string {
  const scope = state.deleteActivity;
  if (nothingToDelete(state, task, scope)) return t('confirm.deleteActivity.nothing');
  const parts = ['worktree', 'branch', 'terminals', ...SCOPE_PARTS.filter((part) => scope[part])] as const;
  return [t('confirm.deleteActivity.lead'), ...parts.map((part) => `• ${t(`confirm.deleteActivity.${part}`)}`)].join('\n');
}

// The source the issue lives in, by its host: the name the user knows it by
function sourceName(url: string): string {
  const host = new URL(url).hostname;
  if (host === 'github.com') return 'GitHub';
  return host.endsWith('.atlassian.net') ? 'Jira' : host;
}

const copy = (text: string): void => {
  navigator.clipboard.writeText(text).then(() => toast.success(t('detail.copied')), (err: Error) => toast.error(err.message));
};

// começar sozinho is the task's auto (#164, #573): the item keeps the menu open, so the switch shows the flip. The detail's ⋯ and the task's
// right-click render it, each with its menu's kit (#542)
export function AutoStartItem({ task, kit = DROPDOWN_KIT }: { task: Task; kit?: MenuKit }) {
  const { Item } = kit;
  const toggle = (event: Event): void => {
    event.preventDefault();
    void act(`/tasks/${encodeURIComponent(task.item.itemId)}/auto`, { auto: !task.auto });
  };
  return (
    <Item role="menuitemcheckbox" aria-checked={task.auto} onSelect={toggle}>
      {t('detail.menu.autoStart')}
      <Switch checked={task.auto} aria-hidden tabIndex={-1} className="pointer-events-none ml-auto" />
    </Item>
  );
}

/** The detail footer's ⋯ (redesign 06): open the issue, copy its link and the branch, whether the worker starts the task on its own, and the
 * worktree's removal (#182, #236), disabled with the reason in its label while it cannot run (#210) and absent on a local task (#444).
 * The removal's confirm and force popup live beside the menu, which closes on the pick. */
export function DetailMenu({ task, state }: { task: Task; state: State }) {
  const [isRemoving, setIsRemoving] = useState(false);
  const { url } = task.item;
  const hasIssue = url.startsWith('http');
  const blocker = deletionBlocker(task, state);
  const live = activityOf(state, task.item.itemId); // the worktree fields are the live activity's (#629)
  const branch = live?.branch;
  const remove = t('detail.menu.deleteActivity');
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className={`${DETAIL_OUTLINE} ml-auto px-2.5`} aria-label={t('detail.more')}><MoreHorizontalIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-60">
          {hasIssue && <DropdownMenuItem onSelect={() => window.open(url, '_blank', 'noreferrer')}>{t('detail.menu.openIssue', { source: sourceName(url) })}</DropdownMenuItem>}
          {hasIssue && <DropdownMenuItem onSelect={() => copy(url)}>{t('detail.menu.copyLink')}</DropdownMenuItem>}
          <DropdownMenuItem disabled={branch === undefined} onSelect={() => branch && copy(branch)}>{t('detail.menu.copyBranch')}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <AutoStartItem task={task} />
          {!live?.local && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={blocker !== undefined} onSelect={() => setIsRemoving(true)}>
                {blocker ? `${remove} · ${t(`detail.deleteActivityBlocked.${blocker}`)}` : remove}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteActivity
        url={taskDeletionUrl(task, state)} message={deleteActivityMessage(task, state)} available
        confirm={{ open: isRemoving, onOpenChange: setIsRemoving }}
      />
    </>
  );
}
