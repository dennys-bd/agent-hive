import type { ReactNode } from 'react';
import type { DockPanel } from '@/components/DockGroup';
import { PluginsSidebar } from '@/components/plugins/PluginsSidebar';
import { PluginsView } from '@/components/plugins/PluginsView';
import { usePlugins } from '@/hooks/use-plugins';
import { t } from '@/i18n';
import type { PanelId } from '@/lib/dock-layout';

export interface PluginsDock { panel: DockPanel; right: DockPanel; center: ReactNode }
interface PluginsDockArgs { isShown: boolean; workspaces: readonly string[]; activate(id: PanelId): void }

/** The plugins view in the dock (#313), beside MainDock, which is at its line limit: the sidebar as the left column's panel, the right group's
 * body while the view is shown, and the centre. The state lives here, in the always-mounted dock, so the open screen survives a switch away. */
export function usePluginsDock({ isShown, workspaces, activate }: PluginsDockArgs): PluginsDock {
  const plugins = usePlugins(isShown);
  return {
    panel: { id: 'plugins', title: t('dock.plugins'), ownHeader: true, body: <PluginsSidebar plugins={plugins} workspaces={workspaces} isShown={isShown} activate={activate} /> },
    // The variables pane's content is 3.7's (decision 20): the right group holds it empty, under the header's variables tab
    right: { id: 'detail', title: t('files.tab.variables'), ownHeader: true, body: <section aria-label={t('files.tab.variables')} className="flex min-h-0 flex-1" /> },
    center: isShown ? <PluginsView plugins={plugins} workspaces={workspaces} /> : null,
  };
}
