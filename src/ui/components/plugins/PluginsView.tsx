import type { CatalogueItem } from '../../../types';
import { HeaderSlot } from '@/components/HeaderSlot';
import { ListScreen } from '@/components/plugins/ListScreen';
import { McpScreen } from '@/components/plugins/McpScreen';
import { PluginsHead } from '@/components/plugins/PluginsHead';
import { ProtocolScreen } from '@/components/plugins/ProtocolScreen';
import { SkillEditor } from '@/components/plugins/SkillEditor';
import { UpdateScreen } from '@/components/plugins/UpdateScreen';
import type { AssistPick } from '@/hooks/use-assist';
import type { Annotations } from '@/hooks/use-annotations';
import type { ItemEditor } from '@/hooks/use-item-editor';
import type { Plugins } from '@/hooks/use-plugins';
import type { Protocol } from '@/hooks/use-protocol';

const NO_ITEMS: CatalogueItem[] = [];
interface PluginsViewProps {
  plugins: Plugins; editor: ItemEditor; annotations: Annotations; protocol: Protocol; workspaces: readonly string[]; fontFamily: string;
  pick: AssistPick; onPick(pick: AssistPick): void;
}

/** The plugins view's centre (#313, #319, #323): the open screen, its head portalled into the header's centre. A skill or a specialist opens
 * its editor, a version's update its screen (#325), mcp its tools and servers (#334), protocol its blocks and passages (#337). Mounted only
 * while the view is shown, so the slot holds its head and no other view's. */
export function PluginsView({ plugins, editor, annotations, protocol, workspaces, fontFamily, pick, onPick }: PluginsViewProps) {
  const { screen } = plugins;
  return (
    <div data-plugins-screen={screen.kind} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <HeaderSlot><PluginsHead plugins={plugins} editor={editor} annotations={annotations} workspaces={workspaces} /></HeaderSlot>
      {screen.kind === 'list' && <ListScreen key={screen.section} plugins={plugins} section={screen.section} workspaces={workspaces} />}
      {editor.item && <SkillEditor editor={editor} annotations={annotations} items={plugins.items ?? NO_ITEMS} workspaces={workspaces} fontFamily={fontFamily} pick={pick} onPick={onPick} />}
      {screen.kind === 'update' && <UpdateScreen key={`${screen.id}/${screen.version}`} plugins={plugins} id={screen.id} version={screen.version} />}
      {screen.kind === 'mcp' && <McpScreen plugins={plugins} workspaces={workspaces} />}
      {screen.kind === 'protocol' && <ProtocolScreen protocol={protocol} workspaces={workspaces} />}
    </div>
  );
}
