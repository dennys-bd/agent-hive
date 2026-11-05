import { activityOf } from '../../../activities.js';
import { resolveWorkspace } from '../../../tasks.js';
import type { State, Task } from '../../../types.js';
import { ListingLine, openOnClick, TaskTitle, useOpenActivity } from '@/components/FlowTask';
import { useTaskNavKeys } from '@/hooks/use-task-keys';
import { t } from '@/i18n';
import { taskState } from '@/lib/task-state';

// The screen's .m-card (#578 decision 8): theme tokens only; the dashed border goes with the ◌ line, as on the flowchart (#576)
const CARD = 'flex flex-col gap-1.5 rounded-lg border bg-card px-2.5 py-[9px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

// Decision 9: {workspace} · {branch} once started, {workspace} · nova while new; a part that does not resolve goes with its separator
function PlaceLine({ task, state, isNew }: { task: Task; state: State; isNew: boolean }) {
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks);
  const tail = isNew ? t('status.new') : activityOf(state, task.item.itemId)?.branch;
  const text = [workspace, tail].filter((part) => part !== undefined).join(' · ');
  return text === '' ? null : <span className="truncate text-muted-foreground text-xs" title={text}>{text}</span>;
}

interface OutsideCardProps { task: Task; state: State; isSelected: boolean; onOpen?(taskId: string): void }

/** A task outside the flow in the grid (#578): its title with the workspace square, where it lives, the out-of-listing hint, and a footer.
 * A click on its free area opens the details, and it takes the task keys (#585). No drag: there is no stage to drop on. */
export function OutsideCard({ task, state, isSelected, onOpen }: OutsideCardProps) {
  const isNew = taskState(task, state) === 'new';
  const openActivity = useOpenActivity(task, state);
  const onKeyDown = useTaskNavKeys(task, state, onOpen, openActivity);
  const frame = `${task.outOfListing === undefined ? '' : ' border-dashed'}${isSelected ? ' ring-2 ring-ring/35' : ''}`;
  return (
    <li
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the task keys act on it (#585), as the flowchart's card
      tabIndex={0} data-task-id={task.item.itemId} aria-current={isSelected ? 'true' : undefined}
      onClick={openOnClick(task.item.itemId, onOpen)} onKeyDown={onKeyDown} className={`${CARD}${frame}`}
    >
      <TaskTitle task={task} state={state} />
      <PlaceLine task={task} state={state} isNew={isNew} />
      <ListingLine task={task} />
    </li>
  );
}
