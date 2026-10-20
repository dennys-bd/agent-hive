import { type ReactNode, useContext, useState } from 'react';
import type { DockPanel } from '@/components/DockGroup';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { PluginsSidebar } from '@/components/plugins/PluginsSidebar';
import { PluginsView } from '@/components/plugins/PluginsView';
import { VariablesPane } from '@/components/plugins/VariablesPane';
import { ViewAsSelect } from '@/components/plugins/ViewAsSelect';
import type { AssistPick } from '@/hooks/use-assist';
import { useAnnotations } from '@/hooks/use-annotations';
import { useItemEditor } from '@/hooks/use-item-editor';
import { usePlugins } from '@/hooks/use-plugins';
import { useProtocol } from '@/hooks/use-protocol';
import { t } from '@/i18n';
import type { PanelId } from '@/lib/dock-layout';
import { HIVE_ORIGIN } from '@/lib/plugins';

export interface PluginsDock { panel: DockPanel; right: DockPanel; center: ReactNode }
interface PluginsDockArgs { isShown: boolean; workspaces: readonly string[]; activate(id: PanelId): void; fontFamily: string }

/** The plugins view in the dock (#313), beside MainDock, which is at its line limit: the sidebar as the left column's panel, the right group's
 * body while the view is shown, and the centre. The state lives here, in the always-mounted dock, so the open screen and the editor's buffers
 * (#319) survive a switch away, and the protocol's drafts (#337) too. */
export function usePluginsDock({ isShown, workspaces, activate, fontFamily }: PluginsDockArgs): PluginsDock {
  const plugins = usePlugins(isShown);
  const editor = useItemEditor(plugins);
  const annotations = useAnnotations(editor, plugins.items, workspaces); // #327: one lint for the text, the map, the pane and the head
  // #337: the centre's cards and the right pane share its drafts, its selected passage and "view as"
  const protocol = useProtocol(isShown && plugins.screen.kind === 'protocol');
  // #331: the chip's pick for every item until the app closes, never written to the config; the default agent until the user picks
  const defaultAgent = useContext(DefaultAgentContext);
  const [picked, setPicked] = useState<AssistPick>();
  const pick = picked ?? { agent: defaultAgent, model: '' };
  const isHiveItem = editor.item?.origin === HIVE_ORIGIN; // a workspace item has no variables, so no "view as" (decision 22)
  return {
    panel: { id: 'plugins', title: t('dock.plugins'), ownHeader: true, body: <PluginsSidebar plugins={plugins} workspaces={workspaces} isShown={isShown} activate={activate} /> },
    // "View as" heads the variables pane (#319); the open file's variables sit under it (#321)
    right: {
      id: 'detail', title: t('files.tab.variables'), ownHeader: true,
      body: (
        <section aria-label={t('files.tab.variables')} className="flex min-h-0 flex-1 flex-col">
          {isHiveItem && <ViewAsSelect value={editor.viewAs} workspaces={workspaces} onChange={editor.setViewAs} />}
          {isHiveItem && <VariablesPane editor={editor} annotations={annotations} workspaces={workspaces} />}
        </section>
      ),
    },
    center: isShown
      ? <PluginsView plugins={plugins} editor={editor} annotations={annotations} protocol={protocol} workspaces={workspaces} fontFamily={fontFamily} pick={pick} onPick={setPicked} />
      : null,
  };
}
