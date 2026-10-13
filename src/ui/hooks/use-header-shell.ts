import type { ReactNode } from 'react';
import type { CenterMode } from '@/hooks/use-activity';
import type { Activity } from '@/lib/activities';
import type { PanelId, Side, ViewLayout } from '@/lib/dock-layout';

/** A pane the right side shows (#221): the activity sidebar's arquivos and detalhes, the panes the header's icons name. */
export type RightPane = 'files' | 'details';

/** What MainDock hands the window header (#221): the center's view, the layout DockFrame draws, whether the right column shows, the activity's
 * bar, the right panes and whether the right side can open at all. Here rather than in MainDock, which is at its line limit. */
export interface HeaderShell {
  center: CenterMode;
  layout: ViewLayout; // frameLayout: the home's hidden right side reads as closed
  rightShown: boolean;
  bar?: ReactNode; // the activity's bar content, absent with no activity
  panes: { active?: RightPane; enabled: Record<RightPane, boolean>; pick(pane: RightPane): void };
  canOpenRight: boolean; // false on the home
}

interface ShellArgs {
  center: CenterMode; current?: Activity; layout: ViewLayout; isHome: boolean; bar?: ReactNode; sideTab: RightPane;
  setSideTab(tab: RightPane): void; activateTab(id: PanelId): void; close(side: Side): void;
}

// The pane the right group shows today: Detalhes under the flow; under atividades the side's tab on a task's activity and arquivos alone on a
// local one (#633); none on the home, which hides the side
function activePane(center: CenterMode, current: Activity | undefined, sideTab: RightPane): RightPane | undefined {
  if (center === 'automation') return 'details';
  if (current === undefined) return undefined;
  return current.kind === 'task' ? sideTab : 'files';
}

/** The header's shell (#221), from what MainDock already holds. The active icon closes the right side, as the group's × does; another opens it
 * on its pane. The pick survives under the flow but its bar does not: the flow and the home have none, so the center column stays empty. */
export function useHeaderShell({ center, current, layout, isHome, bar, sideTab, setSideTab, activateTab, close }: ShellArgs): HeaderShell {
  const isActivities = center === 'activities';
  const active = activePane(center, current, sideTab);
  const pick = (pane: RightPane): void => {
    if (pane === active) {
      close('right');
      return;
    }
    activateTab('detail');
    setSideTab(pane);
  };
  return {
    center, layout, bar: isActivities ? bar : undefined, canOpenRight: !isHome, // nothing to open on the home
    rightShown: layout.open.right, // Detalhes is always the right group (#295)
    panes: { active, enabled: { files: isActivities && current !== undefined, details: !isActivities || current?.kind === 'task' }, pick },
  };
}
