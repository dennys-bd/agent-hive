import type { ReactNode } from 'react';
import type { CenterMode } from '@/hooks/use-activity';
import type { MessageKey } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { PanelId, Side, ViewLayout } from '@/lib/dock-layout';

/** A pane the right side shows (#221): the activity sidebar's arquivos and detalhes, and plugins' variáveis (#313). */
export type RightPane = 'files' | 'details' | 'variables';
type SidePane = Exclude<RightPane, 'variables'>; // the activity sidebar's own tabs

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
  center: CenterMode; current?: Activity; layout: ViewLayout; isHome: boolean; bar?: ReactNode; sideTab: SidePane;
  setSideTab(tab: SidePane): void; activateTab(id: PanelId): void; close(side: Side): void;
}

/** The tooltip of a pane the shown view never has (#313, #461): every pane in benchmark, the others in plugins, variáveis outside plugins;
 * undefined while the pane is the view's. */
export function paneHint(center: CenterMode, pane: RightPane): MessageKey | undefined {
  if (pane === 'variables') return center === 'plugins' ? undefined : 'header.pane.onlyPlugins';
  return center === 'plugins' || center === 'benchmark' ? 'header.pane.unavailable' : undefined;
}

// The pane the right group shows today: variáveis in plugins (#313), Detalhes under the flow; under atividades the side's tab on a task's
// activity and arquivos alone on a local one (#633); none on the home, which hides the side
function activePane(center: CenterMode, current: Activity | undefined, sideTab: SidePane): RightPane | undefined {
  if (center === 'benchmark') return undefined; // #461: the right column has no pane yet; panel-right opens it empty
  if (center === 'plugins') return 'variables';
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
    if (pane !== 'variables') setSideTab(pane);
  };
  const enabled = { files: isActivities && current !== undefined, details: center === 'automation' || (isActivities && current?.kind === 'task'), variables: center === 'plugins' };
  return {
    center, layout, bar: isActivities ? bar : undefined, canOpenRight: !isHome, // nothing to open on the home
    rightShown: layout.open.right, // Detalhes is always the right group (#295)
    panes: { active, enabled, pick },
  };
}
