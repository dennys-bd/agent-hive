import { CheckIcon, MoreHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import type { WorkspaceView } from '@/lib/activities-view';
import { GROUP_MODES, type GroupMode } from '@/lib/activity-groups';

const MODE_LABEL: Record<GroupMode, MessageKey> = { stage: 'activities.groupBy.stage', status: 'activities.groupBy.status', none: 'activities.groupBy.none' };

interface WorkspaceMenuProps {
  name: string; view: WorkspaceView; onView(patch: Partial<WorkspaceView>): void; onCollapseTasks(): void; onExpandTasks(): void; onSettings?(): void;
}

/** A workspace's ⋯ (#586): how its activities group, ✓ on the active mode; whether their worktree line shows; collapse or expand every task
 * of it (#913), two items since a single toggle reads wrong while some are collapsed and others not; then Settings on workspaces and
 * remover workspace…, disabled until the Hive can remove one. 220px, aligned to the ⋯'s end so it stays inside the sidebar. The switch is the
 * item's look: the item itself is the menuitemcheckbox. */
export function WorkspaceMenu({ name, view, onView, onCollapseTasks, onExpandTasks, onSettings }: WorkspaceMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t('activities.workspaceMenu', { name })}><MoreHorizontalIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <DropdownMenuLabel>{t('activities.groupBy')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={view.mode}>
          {GROUP_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode} onSelect={() => onView({ mode })}>
              {t(MODE_LABEL[mode])}
              {view.mode === mode && <CheckIcon className="ml-auto size-3.5" />}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem role="menuitemcheckbox" aria-checked={view.showWorktree} onSelect={() => onView({ showWorktree: !view.showWorktree })}>
          {t('activities.showWorktree')}
          <Switch checked={view.showWorktree} tabIndex={-1} aria-hidden="true" className="pointer-events-none ml-auto" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCollapseTasks}>{t('activities.collapseTasks')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onExpandTasks}>{t('activities.expandTasks')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {onSettings && <DropdownMenuItem onSelect={onSettings}>{t('activities.workspaceSettings')}</DropdownMenuItem>}
        <DropdownMenuItem disabled className="text-destructive">{t('activities.removeWorkspace')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
