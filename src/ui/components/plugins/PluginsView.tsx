import type { CatalogueItem } from '../../../types';
import { HeaderSlot } from '@/components/HeaderSlot';
import { ListScreen } from '@/components/plugins/ListScreen';
import { PluginsHead } from '@/components/plugins/PluginsHead';
import { SkillEditor } from '@/components/plugins/SkillEditor';
import { UpdateScreen } from '@/components/plugins/UpdateScreen';
import type { AssistPick } from '@/hooks/use-assist';
import type { Annotations } from '@/hooks/use-annotations';
import type { ItemEditor } from '@/hooks/use-item-editor';
import type { Plugins } from '@/hooks/use-plugins';

const NO_ITEMS: CatalogueItem[] = [];
interface PluginsViewProps { plugins: Plugins; editor: ItemEditor; annotations: Annotations; workspaces: readonly string[]; fontFamily: string; pick: AssistPick; onPick(pick: AssistPick): void }

/** The plugins view's centre (#313, #319, #323): the open screen, its head portalled into the header's centre. A skill or a specialist opens
 * its editor and a version's update its screen (#325); mcp and protocol are still their own tasks (5.2, 6.2), an empty centre under their
 * head. Mounted only while the view is shown, so the slot holds its head and no other view's. */
export function PluginsView({ plugins, editor, annotations, workspaces, fontFamily, pick, onPick }: PluginsViewProps) {
  const { screen } = plugins;
  return (
    <div data-plugins-screen={screen.kind} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <HeaderSlot><PluginsHead plugins={plugins} editor={editor} annotations={annotations} workspaces={workspaces} /></HeaderSlot>
      {screen.kind === 'list' && <ListScreen key={screen.section} plugins={plugins} section={screen.section} workspaces={workspaces} />}
      {editor.item && <SkillEditor editor={editor} annotations={annotations} items={plugins.items ?? NO_ITEMS} workspaces={workspaces} fontFamily={fontFamily} pick={pick} onPick={onPick} />}
      {screen.kind === 'update' && <UpdateScreen key={`${screen.id}/${screen.version}`} plugins={plugins} id={screen.id} version={screen.version} />}
    </div>
  );
}
