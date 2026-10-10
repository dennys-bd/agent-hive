import { ChevronDownIcon } from 'lucide-react';
import { canDiff } from '../../task-runs';
import type { Activity, Task, TaskDiff, DiffScope } from '../../types';
import { ReviewBar, type ReviewBarState } from '@/components/ReviewBar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { type MessageKey, t } from '@/i18n';

const SCOPES: readonly DiffScope[] = ['worktree', 'stage', 'commit'];
const SCOPE_KEY: Record<DiffScope, MessageKey> = { worktree: 'diff.scope.worktree', stage: 'diff.scope.stage', commit: 'diff.scope.commit' };

// Why the task has no diff of `scope` (#591), as the route's 409 would: no worktree on disk, else no start in its current stage
function noDiffReason(task: Task, activity: Activity | undefined, scope: DiffScope): string | undefined {
  if (canDiff(task, activity, scope)) return undefined;
  return canDiff(task, activity, 'worktree') ? t('diff.noStageStart') : t('diff.noWorktree');
}

interface ScopePickerProps { scope: DiffScope; task: Task; activity: Activity; base?: string; onScope(scope: DiffScope): void }

function ScopePicker({ scope, task, activity, base, onScope }: ScopePickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="xs" variant="ghost" aria-label={t('diff.scope')} title={base === undefined ? undefined : t('diff.base', { base })}>
          {t(SCOPE_KEY[scope])}<ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SCOPES.map((item) => {
          const reason = noDiffReason(task, activity, item);
          return (
            <DropdownMenuItem key={item} disabled={reason !== undefined} title={reason} onSelect={() => { if (item !== scope) onScope(item); }}>
              {t(SCOPE_KEY[item])}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DiffBarProps extends ReviewBarState { scope: DiffScope; task: Task; activity: Activity; diff?: TaskDiff; onScope(scope: DiffScope): void } // activity: the task's live one (#629)

/** The diff pane's bar (#591, #592): its scope picker on the left, the shared bar after it. */
export function DiffBar({ scope, task, activity, diff, onScope, ...bar }: DiffBarProps) {
  return <ReviewBar label={t('diff.bar')} left={<ScopePicker scope={scope} task={task} activity={activity} base={diff?.base} onScope={onScope} />} files={diff?.files} {...bar} />;
}
