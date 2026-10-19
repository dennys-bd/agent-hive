import { HeaderSlotProvider, useHeaderSlotRef } from '@/components/HeaderSlot';
import { usePluginsDock } from '@/components/plugins/plugins-dock';
import { WORKSPACES } from './plugins-fixtures';

// The plugins view as MainDock lays it out, without the rest of the dock (#319): the header's slot, the sidebar, the centre, the right body
function Slot() {
  const register = useHeaderSlotRef();
  return <div ref={register} data-testid="head" />;
}
function Dock() {
  const dock = usePluginsDock({ isShown: true, workspaces: WORKSPACES, activate: () => undefined, fontFamily: 'ui-monospace' });
  return (
    <>
      {dock.panel.body}
      {dock.center}
      <aside>{dock.right.body}</aside>
    </>
  );
}
export function PluginsWindow() {
  return <HeaderSlotProvider><Slot /><Dock /></HeaderSlotProvider>;
}
