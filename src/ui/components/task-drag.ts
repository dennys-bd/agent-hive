import { type DragEvent, type RefObject, useState } from 'react';
import { activityOf } from '../../activities';
import { canMoveToStage, type WorkersState } from '../../tasks';
import type { Activity, Task, Stage } from '../../types';
import { act } from '@/components/actions';
import type { MessageKey } from '@/i18n';

// The flow's task drag (#122, #123, #366), apart from Flow.tsx: a reorder within a stage, and a move to another stage for a task
// canMoveToStage allows. HTML5 drag and drop, where a ref says what is being dragged, since dataTransfer data is unreadable until the drop.

/** The task being dragged since its dragstart: what dragover checks. `movable` is canMoveToStage at dragstart (#366): whether a stage
 * other than its own may take it. */
export interface Dragging { id: string; stage: string; movable: boolean }
export type DragRef = RefObject<Dragging | undefined>;

/** Where a drop lands: before that task, or the end of the stage. */
type Target = string | 'end';

/** The four drag handlers for one task, built by the stage against its own state and full task order (see `taskDragProps`). */
export interface TaskDragHandlers { draggable: true; onDragStart(e: DragEvent): void; onDragEnd(): void; onDragOver(e: DragEvent): void; onDrop(e: DragEvent): void }

const movePath = (id: string): string => `/tasks/${encodeURIComponent(id)}/move`;
const moveToPath = (id: string): string => `/tasks/${encodeURIComponent(id)}/move-to`;

// A drop is allowed from a task of the same stage, a reorder, or from another stage when the task may change stage (#366); the browser
// shows the no-drop cursor otherwise.
const accepts = (drag: Dragging | undefined, stage: string): drag is Dragging => drag !== undefined && (drag.stage === stage || drag.movable);

// Where the pointer's clientY sits against the hovered task's own box, in the stage's full order (not the collapsed subset):
// the upper half targets the task itself, the lower half targets what comes right after it, or the end when it is last.
function dropTargetAt(e: DragEvent, task: Task, tasks: Task[]): Target {
  const rect = e.currentTarget.getBoundingClientRect();
  if (e.clientY < rect.top + rect.height / 2) return task.item.itemId;
  const next = tasks[tasks.indexOf(task) + 1];
  return next ? next.item.itemId : 'end';
}

// A target that already matches where the dragged task sits (before itself, before what already follows it, or the end when
// it is already last) is not a move: no line, no request — the "dropped on itself" rule, generalized to a half.
function isNoOpTarget(target: Target, draggedId: string, tasks: Task[]): boolean {
  if (target === draggedId) return true;
  const index = tasks.findIndex((c) => c.item.itemId === draggedId);
  if (index === -1) return false; // the dragged task left this stage mid-drag (e.g. a live update): nothing to compare against
  if (target === 'end') return index === tasks.length - 1;
  return tasks[index + 1]?.item.itemId === target;
}

// The line's place for `target`, or none: only a task of this stage can already sit there; one from another stage always moves (#366).
const shownTarget = (drag: Dragging, stage: string, target: Target, tasks: Task[]): Target | undefined =>
  (drag.stage === stage && isNoOpTarget(target, drag.id, tasks) ? undefined : target);

// The drop's request. A task of this stage reorders through /move, as before; one from another stage goes through /move-to with this
// stage and where it landed, `before` left out at the end (#366). Its stage comes from the ref: the drop's dataTransfer carries the id only.
function postDrop(drag: DragRef, dragged: string, stage: string, target: Target, tasks: Task[]): void {
  const from = drag.current;
  if (!from || from.id !== dragged) return;
  if (from.stage !== stage) act(moveToPath(dragged), { stage, drop: target === 'end' ? {} : { before: target } });
  else if (!isNoOpTarget(target, dragged, tasks)) act(movePath(dragged), target === 'end' ? undefined : { before: target });
}

const idle = ({ workerId: _workerId, ...activity }: Activity): Activity => activity;

/** A task's tooltip (#366): whether a drag may also take it to another stage, or, when only its stage run holds it, that stopping the
 * stage would let it. */
export function dragHint(task: Task, state: WorkersState): MessageKey {
  if (canMoveToStage(task, state)) return 'task.dragMove';
  // With no run at all it could move: its stage run is what holds it. The run is its activity's workerId (#629)
  const live = activityOf(state, task.item.itemId);
  const activities = state.activities.map((a) => (a === live ? idle(a) : a));
  return canMoveToStage(task, { ...state, activities, workers: [] }) ? 'task.dragRunning' : 'task.drag';
}

/** The bit of `useStageDrag`'s state a task's own handlers need to read and update. */
interface DragLine {
  dropBefore: Target | undefined;
  setDropBefore(v: Target | undefined): void;
  setDraggedId(id: string | undefined): void;
  clearDrag(): void;
}

// Per-task drag/drop for a stage: dragover shows where the task would land (in the stage's own state, via `line`), and drop
// recomputes the same target fresh from the event rather than trusting the state, so the request always matches.
function taskDragProps(drag: DragRef, task: Task, tasks: Task[], line: DragLine, state: WorkersState): Omit<TaskDragHandlers, 'draggable'> {
  const itemId = task.item.itemId;
  return {
    onDragStart: (e: DragEvent): void => {
      e.dataTransfer.setData('text/plain', itemId); // Firefox starts no drag without data
      drag.current = { id: itemId, stage: task.stage, movable: canMoveToStage(task, state) };
      line.setDraggedId(itemId);
    },
    onDragEnd: (): void => {
      drag.current = undefined;
      line.clearDrag();
    },
    onDragOver: (e: DragEvent): void => {
      const from = drag.current;
      if (!accepts(from, task.stage)) return;
      e.preventDefault();
      e.stopPropagation(); // the list behind would otherwise see the same event and show the end instead
      const target = shownTarget(from, task.stage, dropTargetAt(e, task, tasks), tasks);
      if (target !== line.dropBefore) line.setDropBefore(target); // only re-render when the line actually moves
    },
    onDrop: (e: DragEvent): void => {
      e.preventDefault();
      e.stopPropagation(); // the list behind would post the same move without before
      const target = dropTargetAt(e, task, tasks);
      line.clearDrag();
      postDrop(drag, e.dataTransfer.getData('text/plain'), task.stage, target, tasks);
    },
  };
}

interface StageDrag {
  draggedId: string | undefined;
  dropBefore: Target | undefined;
  taskDragProps(task: Task): Omit<TaskDragHandlers, 'draggable'>;
  dropAtEnd(e: DragEvent): void;
  dragOverEnd(e: DragEvent): void;
  onListDragLeave(e: DragEvent): void;
}

/** Where a task is being dragged over `stage` shows as state here (a drop position and the dragged id), since the shared `drag`
 * ref alone never re-renders: a task of this stage, or one from another stage that may change stage (#366). Drop always recomputes
 * its target fresh from the event instead of trusting the state, so the request matches what the line just showed. Cleared on drop and
 * on dragend; dragleave of the list clears only the line, since the dragged task stays mid-drag even while the pointer sits outside it. */
export function useStageDrag(drag: DragRef, stage: Stage, tasks: Task[], state: WorkersState): StageDrag {
  const [draggedId, setDraggedId] = useState<string>();
  const [dropBefore, setDropBefore] = useState<Target>();
  const clearDropLine = (): void => setDropBefore(undefined);
  const clearDrag = (): void => { setDraggedId(undefined); clearDropLine(); };
  const line: DragLine = { dropBefore, setDropBefore, setDraggedId, clearDrag };

  const dropAtEnd = (e: DragEvent): void => {
    e.preventDefault();
    clearDrag();
    postDrop(drag, e.dataTransfer.getData('text/plain'), stage.name, 'end', tasks);
  };
  const dragOverEnd = (e: DragEvent): void => {
    const from = drag.current;
    if (!accepts(from, stage.name)) return;
    e.preventDefault();
    const target = shownTarget(from, stage.name, 'end', tasks);
    if (target !== dropBefore) setDropBefore(target); // only re-render when the line actually moves
  };
  const onListDragLeave = (e: DragEvent): void => {
    const related = e.relatedTarget as Node | null;
    if (!related || !e.currentTarget.contains(related)) clearDropLine();
  };

  return { draggedId, dropBefore, taskDragProps: (task) => taskDragProps(drag, task, tasks, line, state), dropAtEnd, dragOverEnd, onListDragLeave };
}
