import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import type { State } from '../../../types.js';
import { TaskListRow } from '@/components/tasks/TaskListRow';
import { t } from '@/i18n';
import { LIST_PAGE, type ListGroup, pageCut } from '@/lib/task-list';

export interface TaskListGroupProps { group: ListGroup; state: State; isCollapsed: boolean; onToggle(): void; onOpen?(taskId: string): void }

// The group's header (decision 3, handoff §6): the chevron, the flow's name (sem fluxo with its hint), the count and ● N in the waiting colour
// when some task needs you. Sticky under the column headers, as the source table's group row
function GroupHeader({ group, isCollapsed, onToggle }: Omit<TaskListGroupProps, 'state' | 'onOpen'>) {
  const Chevron = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <tr className="sticky top-[34px] z-[5] flex h-[34px] items-center border-b bg-card px-3 text-muted-foreground text-xs">
      <td className="min-w-0 flex-1">
        <button type="button" aria-expanded={!isCollapsed} onClick={onToggle} className="flex w-full min-w-0 items-center gap-1.5">
          <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-foreground" />
          <span className="truncate font-semibold text-[13px] text-foreground">{group.flow?.name ?? t('tasks.sidebar.outside')}</span>
          {group.flow === undefined && <span className="truncate">{t('tasks.list.outsideHint')}</span>}
          <span className="shrink-0 rounded-[9px] bg-muted px-1.5 tabular-nums">{group.rows.length}</span>
          {group.needsYou > 0 && <span className="shrink-0 text-signal-yellow tabular-nums">{`● ${group.needsYou}`}</span>}
        </button>
      </td>
    </tr>
  );
}

/** A flow's group, or sem fluxo's (#577): its header and, unless collapsed, its rows a page at a time (decision 7). The shown count is
 * session-only, and pageCut never splits a tree. */
export function TaskListGroup({ group, state, isCollapsed, onToggle, onOpen }: TaskListGroupProps) {
  const [shown, setShown] = useState(LIST_PAGE);
  const cut = pageCut(group.rows, shown);
  const hidden = group.rows.length - cut;
  return (
    <tbody className="block">
      <GroupHeader group={group} isCollapsed={isCollapsed} onToggle={onToggle} />
      {!isCollapsed && group.rows.slice(0, cut).map((row) => <TaskListRow key={row.task.item.itemId} row={row} state={state} onOpen={onOpen} />)}
      {!isCollapsed && hidden > 0 && (
        <tr className="flex h-8 items-center border-b px-3">
          <td>
            <button type="button" className="text-muted-foreground text-xs hover:text-foreground" onClick={() => setShown(cut + LIST_PAGE)}>{t('tasks.list.more', { n: hidden })}</button>
          </td>
        </tr>
      )}
    </tbody>
  );
}
