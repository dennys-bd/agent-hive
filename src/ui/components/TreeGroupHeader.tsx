import { taskLabel } from '../../tasks';
import type { Task } from '../../types';
import { t } from '@/i18n';
import { titleIfCut } from '@/lib/cut-title';

interface TreeGroupHeaderProps { root?: Task; count: number; isCollapsed: boolean; isFaded?: boolean; onToggle(): void }

/** A tree's group header in a stage node (#34): the chevron collapses the group in this node only, then ⑂ and the root, and the group's card
 * count; no root is sem árvore. An li: it sits in the node's task list. Faded when none of its tasks here is in the flow's focus (#35). */
export function TreeGroupHeader({ root, count, isCollapsed, isFaded = false, onToggle }: TreeGroupHeaderProps) {
  // In the button's label too: every group's button would otherwise read alike
  const name = root === undefined ? t('flow.tree.none') : `⑂ ${taskLabel(root)}`;
  return (
    <li className={`flex min-w-0 items-center gap-1 px-0.5 pt-1 text-xs ${isFaded ? 'opacity-30' : ''}`}>
      <button
        type="button" aria-expanded={!isCollapsed} aria-label={`${t(isCollapsed ? 'flow.tree.expand' : 'flow.tree.collapse')} ${name}`}
        className="w-3 shrink-0 text-muted-foreground" onClick={onToggle}
      >
        {isCollapsed ? '›' : '⌄'}
      </button>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the hover only sets a native title on cut text (#91), no interaction */}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" onMouseEnter={titleIfCut(name)}>{name}</span>
      <span className="shrink-0 text-muted-foreground">{count}</span>
    </li>
  );
}
