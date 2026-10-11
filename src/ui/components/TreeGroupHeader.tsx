import { taskLabel } from '../../tasks';
import type { Task } from '../../types';
import { t } from '@/i18n';

interface TreeGroupHeaderProps { root?: Task; count: number; isCollapsed: boolean; onToggle(): void }

/** A tree's group header in a stage node (#34): the chevron collapses the group in this node only, then ⑂ and the root, and the group's card
 * count; no root is sem árvore. An li: it sits in the node's task list. */
export function TreeGroupHeader({ root, count, isCollapsed, onToggle }: TreeGroupHeaderProps) {
  return (
    <li className="flex min-w-0 items-center gap-1 px-0.5 pt-1 text-xs">
      <button
        type="button" aria-expanded={!isCollapsed} aria-label={t(isCollapsed ? 'flow.tree.expand' : 'flow.tree.collapse')}
        className="w-3 shrink-0 text-muted-foreground" onClick={onToggle}
      >
        {isCollapsed ? '›' : '⌄'}
      </button>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{root === undefined ? t('flow.tree.none') : `⑂ ${taskLabel(root)}`}</span>
      <span className="shrink-0 text-muted-foreground">{count}</span>
    </li>
  );
}
