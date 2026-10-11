import { useContext, useEffect, useState } from 'react';
import { descendants, rootOf, treeProgress } from '../../task-tree';
import { taskLabel } from '../../tasks';
import type { State, Task } from '../../types';
import { SEGMENT } from '@/components/TreeProgress';
import { TreeHoverContext } from '@/components/tree-hover';
import { Badge } from '@/components/ui/badge';
import { statusText, t } from '@/i18n';
import { readFlowView, toggleOutline } from '@/lib/flow-view';
import { STATUS_TEXT } from '@/lib/status';
import { isExhausted, taskState } from '@/lib/task-state';
import { inTree, type OutlineRow, outlineRows, treeSegments } from '@/lib/tree-groups';

const ROW_BASE_PX = 8; // the handoff's indent: 8 + depth × 16
const ROW_STEP_PX = 16;

interface TreePartProps { root: Task; state: State; lastStage: string }

// The header (handoff §4): every node below the root, done over all, as the bar draws them; on the right the tasks waiting for the user and
// those out of tries, apart, each only when some are. The root counts in both: it can wait on the user too
function TreeHeader({ root, state, lastStage }: TreePartProps) {
  const { done, total } = treeProgress(state.tasks, root.item.itemId, lastStage);
  const members = [root, ...descendants(state.tasks, root.item.itemId)];
  const waiting = members.filter((task) => taskState(task, state) === 'waiting').length;
  const exhausted = members.filter((task) => isExhausted(task, state)).length;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="shrink-0 font-medium text-foreground">{t('detail.tree')}</span>
      <span className="min-w-0 truncate text-muted-foreground">{t('detail.tree.count', { n: total, done })}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {waiting > 0 && <span className="text-waiting" title={statusText('waiting')}>{`● ${waiting}`}</span>}
        {exhausted > 0 && <span className="text-destructive" title={t('tries.exhausted.title')}>{`● ${exhausted}`}</span>}
      </span>
    </div>
  );
}

// The bar: one segment per node below the root, a child with no task included, in the tree card's colours (#34)
function TreeBar({ root, state, lastStage }: TreePartProps) {
  return (
    <div data-tree-bar className="flex h-1 gap-0.5">
      {treeSegments(state, root.item.itemId, lastStage).map(({ id, tone }) => <span key={id} className={`h-1 flex-1 rounded-[2px] ${SEGMENT[tone]}`} />)}
    </div>
  );
}

interface OutlineItemProps { row: OutlineRow; state: State; isOpen: boolean; onOpenTask(itemId: string): void; onToggle(itemId: string): void }

// One task of the outline: ⌄ / › on a parent, an empty slot of its width otherwise so the labels line up, then the button that opens the task
// and, while the pointer is on it, lights its card in the flow. The slot's 14px and the 4px gap put line 2 at the handoff's 18px
function OutlineItem({ row, state, isOpen, onOpenTask, onToggle }: OutlineItemProps) {
  const { setHoveredId } = useContext(TreeHoverContext);
  const { task, depth, hasChildren, isCollapsed } = row;
  const id = task.item.itemId;
  const label = taskLabel(task);
  const status = taskState(task, state);
  return (
    <li className={`flex items-start gap-1 rounded-md py-1 pr-2 ${isOpen ? 'bg-muted text-foreground' : 'text-foreground/85'}`} style={{ paddingLeft: ROW_BASE_PX + depth * ROW_STEP_PX }}>
      {hasChildren
        ? (
          <button
            type="button" aria-expanded={!isCollapsed} aria-label={`${t(isCollapsed ? 'flow.tree.expand' : 'flow.tree.collapse')} ${label}`}
            className="w-3.5 shrink-0 text-[10px] text-muted-foreground leading-5" onClick={() => onToggle(id)}
          >
            {isCollapsed ? '›' : '⌄'}
          </button>
        )
        : <span aria-hidden="true" className="w-3.5 shrink-0" />}
      <button
        type="button" aria-current={isOpen ? 'true' : undefined} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        onClick={() => onOpenTask(id)} onMouseEnter={() => setHoveredId(id)} onMouseLeave={() => setHoveredId(undefined)}
      >
        <span className="truncate text-[13px] leading-5">{label}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <Badge variant="outline" className="font-normal text-muted-foreground">{task.stage}</Badge>
          <span className={`min-w-0 truncate ${STATUS_TEXT[status]}`}>{statusText(status)}</span>
        </span>
      </button>
    </li>
  );
}

interface TreeSectionProps { task: Task; state: State; onOpenTask(itemId: string): void }

/** The details' tree section (#36, handoff §4): on a task with a parent or a child task in the list, its whole tree from the root over the
 * whole task list (the flow's source and filters aside), as a header, a bar, an outline whose rows open their task and light its card in the
 * flow, and a note. Nothing on a task in no tree. */
export function TreeSection({ task, state, onOpenTask }: TreeSectionProps) {
  // Seeded from flowView and replaced by what toggleOutline wrote: one collapse per parent, shared by every task's details of that tree
  const [collapsed, setCollapsed] = useState(() => readFlowView().outline);
  const { setHoveredId } = useContext(TreeHoverContext);
  // A row that unmounts under the pointer fires no mouseleave: clear the mark, or its card would stay lit
  useEffect(() => () => setHoveredId(undefined), [setHoveredId]);
  if (!inTree(state.tasks, task)) return null;
  const root = rootOf(state.tasks, task.item.itemId) ?? task;
  const lastStage = state.stages.at(-1)?.name ?? '';
  const onToggle = (itemId: string): void => setCollapsed(toggleOutline(itemId));
  return (
    <section aria-label={t('detail.tree')} className="flex flex-col gap-2">
      <TreeHeader root={root} state={state} lastStage={lastStage} />
      <TreeBar root={root} state={state} lastStage={lastStage} />
      <ul className="flex flex-col gap-0.5">
        {outlineRows(state.tasks, root.item.itemId, collapsed).map((row) => (
          <OutlineItem key={row.task.item.itemId} row={row} state={state} isOpen={row.task.item.itemId === task.item.itemId} onOpenTask={onOpenTask} onToggle={onToggle} />
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">{t('detail.tree.hint')}</p>
    </section>
  );
}
