import { type ReactNode, useState } from 'react';
import type { ReviewerConfig } from '../../src/types';
import { HeaderSlotProvider, useHeaderSlotRef } from '@/components/HeaderSlot';
import { usePluginsDock } from '@/components/plugins/plugins-dock';
import { ReviewerContext, reviewerSaver } from '@/hooks/use-reviewer';
import { type ItemsServer, WORKSPACES } from './plugins-fixtures';

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

// #329: the reviewer setting as App provides it: its write posts POST /settings with the prefix, and its reload reads the key the fake saved
function WithReviewer({ server, saved, children }: { server: ItemsServer; saved: ReviewerConfig; children: ReactNode }) {
  const [config, setConfig] = useState(saved);
  const save = reviewerSaver('HIVE', async () => setConfig(server.reviewer ?? saved));
  return <ReviewerContext.Provider value={{ config, save }}>{children}</ReviewerContext.Provider>;
}

export function PluginsWindow({ server }: { server?: ItemsServer }) {
  const shown = <HeaderSlotProvider><Slot /><Dock /></HeaderSlotProvider>;
  return server?.reviewer === undefined ? shown : <WithReviewer server={server} saved={server.reviewer}>{shown}</WithReviewer>;
}
