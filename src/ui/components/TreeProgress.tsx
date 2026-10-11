import { progress } from '../../task-tree';
import type { State, Task } from '../../types';
import { t } from '@/i18n';
import { STATUS_DOT, type TaskState } from '@/lib/status';
import { segmentTone } from '@/lib/tree-groups';

// The handoff's bar: done in muted-foreground, the rest in its status's solid colour, new and empty in the border's. Literals, for Tailwind's scanner. Exported for the details' tree bar (#36), which draws the same colours
export const SEGMENT: Record<TaskState | 'done', string> = { ...STATUS_DOT, done: 'bg-muted-foreground' };

interface TreeProgressProps { task: Task; state: State; onFocusTree?(itemId: string): void }

/** A parent's block on its card (#34): ⑂ N children · done/N over its direct children, focus › only when the caller wires the focus (#35),
 * and a 4px bar with one segment per direct child, task or not. */
export function TreeProgress({ task, state, onFocusTree }: TreeProgressProps) {
  const lastStage = state.stages.at(-1)?.name ?? '';
  const { done, total } = progress(state.tasks, task.item.itemId, lastStage);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        <span aria-hidden="true" className="shrink-0">⑂</span>
        <span className="min-w-0 truncate">{t('flow.tree.children', { n: total, done })}</span>
        {onFocusTree && (
          <button type="button" className="ml-auto shrink-0 font-medium text-foreground" onClick={() => onFocusTree(task.item.itemId)}>{t('flow.tree.focus')}</button>
        )}
      </div>
      <div data-tree-bar className="flex h-1 gap-0.5">
        {(task.item.children ?? []).map((childId) => (
          <span key={childId} className={`h-1 flex-1 rounded-[2px] ${SEGMENT[segmentTone(state, task, childId, lastStage)]}`} />
        ))}
      </div>
    </div>
  );
}
