import { useLayoutEffect, useRef, useState } from 'react';
import { activityOf } from '../../activities';
import { canCloseMissing, workersOf } from '../../tasks';
import type { FilterRule, Stage, State, Task } from '../../types';
import { stageWorkerCount } from '../../worker-count';
import { act } from '@/components/actions';
import { Confirm } from '@/components/Confirm';
import { FlowTask } from '@/components/FlowTask';
import { FilterIndicator } from '@/components/StageFilter';
import { StageMenu } from '@/components/StageMenu';
import { type DragRef, useStageDrag } from '@/components/task-drag';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { executorLine } from '@/lib/flow-labels';
import { hiddenBelow } from '@/lib/flow-layout';
import { taskState } from '@/lib/task-state';

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

// The node's own height, read on every resize: the chart routes the arrows from each node's real bottom
function useHeight(stage: string, onHeight: (stage: string, height: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = (): void => onHeight(stage, node.offsetHeight);
    const observer = new ResizeObserver(read);
    observer.observe(node);
    read();
    return () => observer.disconnect();
  }, [stage, onHeight]);
  return ref;
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
  isListed: boolean; maxHeight: number; cap?: number; onOpen?(taskId: string): void; onFilter(): void; onClearFilter(): void; onList(): void; onHeight(stage: string, height: number): void;
}

/** A stage as a node of the flowchart (#134, 1b): 190px, its header (name, count, ● N awaiting you, ⋯), who runs it, the view filter's indicator
 * (#374), the missing strip (#279) and its tasks, scrolling inside up to `maxHeight`; the footer only when they overflow. `tasks` are what the
 * source pick, the view filter and the search let through; `order` is the stage's whole order, which a drop is read in (#366). */
export function FlowNode(props: FlowNodeProps) {
  const { stage, state, tasks, order, shown, filteredOut, rules, drag, selectedId, isListed, maxHeight, cap, onOpen, onFilter, onClearFilter, onList, onHeight } = props;
  const root = useHeight(stage.name, onHeight);
  const fold = useFold(tasks.length);
  const waiting = order.filter((c) => awaitsYou(c, state)).length;
  const { draggedId, dropBefore, taskDragProps, dropAtEnd, dragOverEnd, onListDragLeave } = useStageDrag(drag, stage, order, state);
  const tailDrop = dropBefore !== undefined && (dropBefore === 'end' || !tasks.some((c) => c.item.itemId === dropBefore));
  return (
    <div ref={root} data-stage={stage.name} style={{ maxHeight }} className={`flex w-[190px] flex-col gap-1.5 rounded-xl border bg-card py-2 pl-2 ${isListed ? 'border-foreground' : ''}`}>
      <div className="flex flex-none items-center gap-1.5 pr-2 text-muted-foreground text-xs">
        <h3 className="truncate font-medium text-foreground">{stage.name}</h3>
        <span>{shown}</span>
        <StageLoad stage={stage.name} cap={cap} state={state} />
        <span className="ml-auto flex items-center gap-1">
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
        {tasks.map((task) => (
          <FlowTask
            key={task.item.itemId} task={task} state={state} dragHandlers={{ draggable: true, ...taskDragProps(task) }} isDimmed={draggedId === task.item.itemId}
            isDropBefore={dropBefore === task.item.itemId} isSelected={selectedId === task.item.itemId} onOpen={onOpen}
          />
        ))}
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
