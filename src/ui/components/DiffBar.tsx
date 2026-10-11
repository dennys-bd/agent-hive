import { ChevronDownIcon } from 'lucide-react';
import { canDiff } from '../../task-runs';
import type { Activity, Checkpoint, Task, TaskDiff, DiffScope } from '../../types';
import { ReviewBar, type ReviewBarState } from '@/components/ReviewBar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { type MessageKey, t } from '@/i18n';

const SCOPES: readonly DiffScope[] = ['worktree', 'stage', 'commit', 'checkpoint'];
const SCOPE_KEY: Record<DiffScope, MessageKey> = { worktree: 'diff.scope.worktree', stage: 'diff.scope.stage', commit: 'diff.scope.commit', checkpoint: 'diff.scope.checkpoint' };

// Why the task has no diff of `scope` (#591), as the route's 409 would: no worktree on disk, else no start in its current stage
function noDiffReason(task: Task, activity: Activity | undefined, scope: DiffScope): string | undefined {
  if (canDiff(task, activity, scope)) return undefined;
  if (!canDiff(task, activity, 'worktree')) return t('diff.noWorktree');
  return scope === 'checkpoint' ? t('diff.noCheckpoints') : t('diff.noStageStart');
}

/** The latest checkpoint's number, what the checkpoint scope opens on (#619). */
export const latestCheckpoint = (activity: Pick<Activity, 'checkpoints'>): number | undefined => activity.checkpoints?.at(-1)?.n;

interface ScopePickerProps { scope: DiffScope; task: Task; activity: Activity; base?: string; onScope(scope: DiffScope, checkpoint?: number): void }

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
            <DropdownMenuItem key={item} disabled={reason !== undefined} title={reason} onSelect={() => { if (item !== scope) onScope(item, item === 'checkpoint' ? latestCheckpoint(activity) : undefined); }}>
              {t(SCOPE_KEY[item])}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const checkpointName = (a: Pick<Checkpoint, 'stage' | 'n'>): string => `${a.stage} · ${a.n}`;

// The checkpoint the checkpoint scope diffs against (#619), latest first
function CheckpointPicker({ checkpoints, checkpoint, onPick }: { checkpoints: readonly Checkpoint[]; checkpoint?: number; onPick(n: number): void }) {
  const chosen = checkpoints.find((a) => a.n === checkpoint);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="xs" variant="ghost" aria-label={t('diff.checkpoint')}>{chosen ? checkpointName(chosen) : '—'}<ChevronDownIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {[...checkpoints].reverse().map((a) => (
          <DropdownMenuItem key={a.n} onSelect={() => { if (a.n !== checkpoint) onPick(a.n); }}>{checkpointName(a)}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DiffBarProps extends ReviewBarState { scope: DiffScope; task: Task; activity: Activity; diff?: TaskDiff; checkpoint?: number; onScope(scope: DiffScope, checkpoint?: number): void } // activity: the task's live one (#629)

/** The diff pane's bar (#591, #592): its scope picker on the left, the shared bar after it. */
export function DiffBar({ scope, task, activity, diff, checkpoint, onScope, ...bar }: DiffBarProps) {
  const left = (
    <>
      <ScopePicker scope={scope} task={task} activity={activity} base={diff?.base} onScope={onScope} />
      {scope === 'checkpoint' && <CheckpointPicker checkpoints={activity.checkpoints ?? []} checkpoint={checkpoint} onPick={(n) => onScope('checkpoint', n)} />}
    </>
  );
  return <ReviewBar label={t('diff.bar')} left={left} files={diff?.files} {...bar} />;
}
