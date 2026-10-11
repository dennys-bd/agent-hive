import { useLayoutEffect, useRef, useState } from 'react';
import { activityOf } from '../../activities';
import { canCloseMissing, workersOf } from '../../tasks';
import type { FilterRule, Stage, State, Task } from '../../types';
import { stageWorkerCount } from '../../worker-count';
import { act } from '@/components/actions';
import { Confirm } from '@/components/Confirm';
import { NODE_WIDTH } from '@/components/FlowChart';
import { FlowTask } from '@/components/FlowTask';
import { FilterIndicator } from '@/components/StageFilter';
import { StageMenu } from '@/components/StageMenu';
import { type DragRef, useStageDrag } from '@/components/task-drag';
import { TreeGroupHeader } from '@/components/TreeGroupHeader';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { executorLine } from '@/lib/flow-labels';
import { hiddenBelow } from '@/lib/flow-layout';
import { isExhausted, taskState } from '@/lib/task-state';
import { flatRows, nodeRows } from '@/lib/tree-groups';

// A task that waits for the user (#134): a session asking, or an approval
const awaitsYou = (task: Task, state: State): boolean => ['waiting', 'approval'].includes(taskState(task, state));

// A stage's close all (#279), between its header and its tasks: every stopped missing task of the stage in one go, behind one confirm that
// says what stays running and that the worktrees stay on disk. Absent while nothing is closable; a running missing task keeps its own close / keep.
function MissingStrip({ stage, tasks, state }: { stage: string; tasks: Task[]; state: State }) {
  const closable = tasks.filter((c) => canCloseMissing(c, state)).length;
  if (closable === 0) return null;
  const running = tasks.filter((c) => c.missing && (activityOf(state, c.item.itemId)?.workerId !== undefined || workersOf(state, c).length > 0)).length;
  const message = [t('confirm.closeMissingAll', { n: closable }), running > 0 ? t('confirm.closeMissingRunning', { m: running }) : ''].filter(Boolean).join(' ');
  return (
    <div className="flex items-center justify-between gap-2 text-destructive text-xs">
      {t('stage.missing', { n: closable })}
      <Confirm
        message={message}
        confirmLabel={t('stage.closeMissing')}
        trigger={<Button type="button" size="xs" variant="outline">{t('stage.closeMissing')}</Button>}
        onConfirm={() => act(`/stages/${encodeURIComponent(stage)}/close-missing`)}
      />
    </div>
  );
}

// The list's fold, read on every scroll and resize: whether it overflows, and how many tasks sit below it
function useFold(count: number) {
  const ref = useRef<HTMLUListElement>(null);
  const [fold, setFold] = useState({ overflows: false, hidden: 0 });
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const read = (): void => setFold({ overflows: list.scrollHeight > list.clientHeight + 1, hidden: hiddenBelow(list.scrollHeight, list.clientHeight, list.scrollTop, count) });
    const observer = new ResizeObserver(read);
    observer.observe(list);
    list.addEventListener('scroll', read);
    read();
    return () => { observer.disconnect(); list.removeEventListener('scroll', read); };
  }, [count]);
  return { ref, ...fold };
}

// A capped stage's workers against its cap (#727): every worker its tasks hold, held approvals and commands runs included. The fill never goes
// over a cap, so what is over was started by hand or kept running under a lowered cap: the number reads in foreground and says how many.
function StageLoad({ stage, cap, state }: { stage: string; cap?: number; state: State }) {
  if (cap === undefined) return null;
  const n = stageWorkerCount(state, stage);
  const over = n - cap;
  return <span className={over > 0 ? 'text-foreground' : undefined} title={over > 0 ? t('flow.stageCap.byHand', { k: over }) : undefined}>{`${n}/${cap}`}</span>;
}

interface FlowNodeProps {
  stage: Stage; state: State; tasks: Task[]; order: Task[]; shown: number; filteredOut: number; rules: FilterRule[]; drag: DragRef; selectedId?: string;
  isListed: boolean; maxHeight: number; cap?: number; onOpen?(taskId: string): void; onFilter(): void; onClearFilter(): void; onList(): void;
  isTree?: boolean; collapsed?: readonly string[]; onToggleGroup?(key: string): void; // #34: the tree toggle Flow resolved, and the collapsed groups
  focus?: ReadonlySet<string>; onFocusTree?(itemId: string): void; // #35: the focus Flow holds, and focus › on a parent's card
}

/** A stage as a node of the flowchart (#134, 1b): NODE_WIDTH wide (#54), its header (name, count, ● N out of tries (#913), ● N awaiting you, ⋯), who runs it, the view filter's indicator
 * (#374), the missing strip (#279) and its tasks, scrolling inside up to `maxHeight`; the footer only when they overflow. `tasks` are what the
 * source pick, the view filter and the search let through; `order` is the stage's whole order, which a drop is read in (#366). */
export function FlowNode(props: FlowNodeProps) {
  const { stage, state, tasks, order, shown, filteredOut, rules, drag, selectedId, isListed, maxHeight, cap, onOpen, onFilter, onClearFilter, onList, isTree = false, collapsed = [], onToggleGroup, focus, onFocusTree } = props;
  // #34: grouped by tree over the whole task list, or as today; a drop still reads `order`, the stage's whole order (#366)
  const rows = isTree ? nodeRows(state.tasks, tasks, stage.name, collapsed) : flatRows(tasks);
  const fold = useFold(rows.filter((row) => row.kind === 'task').length);
  // #35: outside the focus when none of these tasks is in it; with no focus nothing fades. The counts above stay the totals
  const isOut = (itemIds: readonly string[]): boolean => focus !== undefined && !itemIds.some((id) => focus.has(id));
  const waiting = order.filter((c) => awaitsYou(c, state)).length;
  const exhausted = order.filter((c) => isExhausted(c, state)).length;
  const { draggedId, dropBefore, taskDragProps, dropAtEnd, dragOverEnd, onListDragLeave } = useStageDrag(drag, stage, order, state);
  const tailDrop = dropBefore !== undefined && (dropBefore === 'end' || !tasks.some((c) => c.item.itemId === dropBefore));
  return (
    <div data-stage={stage.name} style={{ maxHeight, width: NODE_WIDTH }} className={`flex flex-col gap-1.5 rounded-xl border bg-card py-2 pl-2 ${isListed ? 'border-foreground' : ''}`}>
      <div className="flex flex-none items-center gap-1.5 pr-2 text-muted-foreground text-xs">
        <h3 className="truncate font-medium text-foreground">{stage.name}</h3>
        <span>{shown}</span>
        <StageLoad stage={stage.name} cap={cap} state={state} />
        <span className="ml-auto flex items-center gap-1">
          {exhausted > 0 && <span className="text-destructive" title={t('flow.node.exhausted', { n: exhausted })}>{`● ${exhausted}`}</span>}
          {waiting > 0 && <span className="text-waiting" title={t('flow.node.waiting', { n: waiting })}>{`● ${waiting}`}</span>}
          <StageMenu stage={stage.name} state={state} filtered={rules.length > 0} onFilter={onFilter} onClearFilter={onClearFilter} />
        </span>
      </div>
      <p className="flex-none truncate pr-2 text-muted-foreground text-xs">{executorLine(stage)}</p>
      <FilterIndicator rules={rules} hidden={filteredOut} onClear={onClearFilter} />
      <MissingStrip stage={stage.name} tasks={order} state={state} />
      <ul
        ref={fold.ref} aria-label={stage.name} data-stage-tasks data-drop={tailDrop ? 'end' : undefined} onDragOver={dragOverEnd} onDrop={dropAtEnd} onDragLeave={onListDragLeave}
        className="relative flex min-h-0 flex-[0_1_auto] flex-col gap-1.5 overflow-y-auto pr-2 [scrollbar-width:none] after:absolute after:inset-x-0 after:-bottom-1 after:hidden after:h-0.5 after:bg-primary after:content-[''] data-[drop=end]:after:block"
      >
        {tasks.length === 0 && <li className="text-muted-foreground text-xs">{t(order.length === 0 ? 'stage.empty' : 'stage.filterNone')}</li>}
        {rows.map((row) => (row.kind === 'group'
          ? <TreeGroupHeader key={row.key} root={row.root} count={row.count} isCollapsed={row.isCollapsed} isFaded={isOut(row.itemIds)} onToggle={() => onToggleGroup?.(row.key)} />
          : (
            <FlowTask
              key={row.task.item.itemId} task={row.task} state={state} indent={row.indent} dragHandlers={{ draggable: true, ...taskDragProps(row.task) }}
              isDimmed={draggedId === row.task.item.itemId} isDropBefore={dropBefore === row.task.item.itemId} isSelected={selectedId === row.task.item.itemId} onOpen={onOpen}
              isFaded={isOut([row.task.item.itemId])} onFocusTree={onFocusTree}
            />
          )))}
      </ul>
      {fold.overflows && (
        <div className="flex flex-none items-center justify-between pr-2 text-xs">
          <span className="text-muted-foreground">{t('flow.node.overflow', { n: fold.hidden })}</span>
          <button type="button" className="font-medium text-foreground" onClick={onList}>{t('flow.node.list')}</button>
        </div>
      )}
    </div>
  );
}
