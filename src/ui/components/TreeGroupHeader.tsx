import { useRef } from 'react';
import { taskLabel } from '../../tasks';
import type { Task } from '../../types';
import { t } from '@/i18n';
import { CutTitle } from '@/lib/cut-title';

interface TreeGroupHeaderProps { root?: Task; count: number; isCollapsed: boolean; isFaded?: boolean; onToggle(): void }

/** A tree's group header in a stage node (#34): the whole row is one button (#284) that collapses the group in this node only, the
 * chevron, then ⑂ and the root, and the group's card count; no root is sem árvore. An li: it sits in the node's task list. Faded when none of its tasks here is in the flow's focus (#35). */
export function TreeGroupHeader({ root, count, isCollapsed, isFaded = false, onToggle }: TreeGroupHeaderProps) {
  const nameRef = useRef<HTMLSpanElement>(null);
  // In the button's label too: every group's button would otherwise read alike
  const name = root === undefined ? t('flow.tree.none') : `⑂ ${taskLabel(root)}`;
  return (
    <li className={`flex min-w-0 pt-1 text-xs ${isFaded ? 'opacity-30' : ''}`}>
      <CutTitle text={name} cutRef={nameRef}>
        <button
          type="button" aria-expanded={!isCollapsed} aria-label={`${t(isCollapsed ? 'flow.tree.expand' : 'flow.tree.collapse')} ${name}`}
          className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-1 px-0.5 text-left" onClick={onToggle}
        >
          <span className="w-3 shrink-0 text-muted-foreground">{isCollapsed ? '›' : '⌄'}</span>
          <span ref={nameRef} className="min-w-0 flex-1 truncate font-medium text-foreground">{name}</span>
          <span className="shrink-0 text-muted-foreground">{count}</span>
        </button>
      </CutTitle>
    </li>
  );
}
