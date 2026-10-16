import { HeaderSlot } from '@/components/HeaderSlot';
import { ListScreen } from '@/components/plugins/ListScreen';
import { PluginsHead } from '@/components/plugins/PluginsHead';
import type { Plugins } from '@/hooks/use-plugins';

/** The plugins view's centre (#313): the open screen, its head portalled into the header's centre. The item, mcp and protocol screens are
 * their own tasks (3.5, 3.9, 5.2, 6.2): until then each is an empty centre under its head. Mounted only while the view is shown, so the slot
 * holds its head and no other view's. */
export function PluginsView({ plugins, workspaces }: { plugins: Plugins; workspaces: readonly string[] }) {
  const { screen } = plugins;
  return (
    <div data-plugins-screen={screen.kind} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <HeaderSlot><PluginsHead plugins={plugins} workspaces={workspaces} /></HeaderSlot>
      {screen.kind === 'list' && <ListScreen key={screen.section} plugins={plugins} section={screen.section} workspaces={workspaces} />}
    </div>
  );
}
