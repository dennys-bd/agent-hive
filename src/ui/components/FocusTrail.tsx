import { Fragment } from 'react';
import type { Task } from '../../types';
import { t } from '@/i18n';

interface FocusTrailProps { trail: readonly Task[]; count: number; onFocus(itemId: string): void; onLeave(): void }

// An id as the card reads it: # and the item's id, none for a task created in the Hive (taskLabel's rule)
const idLabel = (task: Task): string => `${task.created ? '' : '#'}${task.item.id}`;

// One level of the path: an ancestor is a button that focuses that level, the focused task plain text
function TrailStep({ task, isLast, onFocus }: { task: Task; isLast: boolean; onFocus(itemId: string): void }) {
  const label = idLabel(task);
  if (isLast) return <span className="font-medium text-foreground">{label}</span>;
  return (
    <button type="button" aria-label={t('flow.focus.to', { id: label })} className="font-medium text-foreground" onClick={() => onFocus(task.item.itemId)}>
      {label}
    </button>
  );
}

/** The focus's trail (#35, handoff §3): pinned to the canvas's top left, outside the chart's transform, so pan and zoom never move it. A pill
 * with ⑂ tree, the path from the root and ×; beside it, how many tasks of the source pick the focus covers. */
export function FocusTrail({ trail, count, onFocus, onLeave }: FocusTrailProps) {
  return (
    <div className="absolute top-2.5 left-3 flex items-center gap-2 text-xs">
      <nav aria-label={t('flow.focus.trail')} className="flex items-center gap-1.5 rounded-[6px] border border-foreground bg-background px-2 py-1">
        <span className="text-muted-foreground">{t('flow.tree')}</span>
        {trail.map((task, index) => (
          <Fragment key={task.item.itemId}>
            {index > 0 && <span aria-hidden="true" className="text-muted-foreground">›</span>}
            <TrailStep task={task} isLast={index === trail.length - 1} onFocus={onFocus} />
          </Fragment>
        ))}
        <button type="button" aria-label={t('flow.focus.leave')} className="text-muted-foreground" onClick={onLeave}>×</button>
      </nav>
      <span className="text-muted-foreground">{t('flow.focus.count', { n: count })}</span>
    </div>
  );
}
