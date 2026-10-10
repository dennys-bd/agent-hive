import { MoreHorizontalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { sessionLabel } from '../../task-runs';
import { AGENT_IDS } from '../../types';
import { act } from '@/components/actions';
import { openLocalRun } from '@/components/local-runs';
import { CONTEXT_KIT, DROPDOWN_KIT, type MenuKit } from '@/components/menu-kit';
import { agentName, RUN_AGENT } from '@/components/NewRunButton';
import { useActivitySleepMenu } from '@/components/SleepMenu';
import { useOpenRun } from '@/components/terminal-tabs';
import { sessionPath } from '@/lib/copy-targets';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import type { LocalActivity } from '@/lib/activities';

const DESTRUCTIVE = 'text-destructive focus:text-destructive';
const MENU_WIDTH = 'w-[236px]';

// The local menu's items (#590) with `kit`: nova sessão opens a terminal or an agent's session in the workspace's checkout; each local session
// (#587) is continued or cleared, as its sidebar line's limpar, neither while its run is live; then dormir (#696), the activity's sleep items.
// No stage, diff, flow or delete item: the local activity holds no task. The sleep dialog sits beside the menu: a pick closes it
function useLocalMenu(activity: LocalActivity, kit: MenuKit): { items: ReactNode; dialog: ReactNode } {
  const openRun = useOpenRun();
  const sleep = useActivitySleepMenu(activity, { kit });
  const { workspace } = activity;
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;
  const clear = (id: string): void => void act(`${sessionPath({ activityId: activity.activity.id, sessionId: id })}/clear`); // the local record (#629)
  const items = (
    <>
      <Sub>
        <SubTrigger>{t('activities.menu.newSession')}</SubTrigger>
        <SubContent>
          <Item onSelect={() => openLocalRun(workspace, 'terminal', openRun)}>{t('activities.menu.terminal')}</Item>
          {AGENT_IDS.map((agent) => <Item key={agent} onSelect={() => openLocalRun(workspace, agent, openRun)}>{agentName(agent)}</Item>)}
        </SubContent>
      </Sub>
      {activity.kept.length > 0 && <Separator />}
      {activity.kept.map(({ session, run }) => (
        <Sub key={session.id}>
          <SubTrigger>{`${agentName(RUN_AGENT)} · ${sessionLabel(session)}`}</SubTrigger>
          <SubContent>
            <Item disabled={run !== undefined} onSelect={() => openLocalRun(workspace, RUN_AGENT, openRun, { continueId: session.id })}>{t('task.continue')}</Item>
            <Item className={DESTRUCTIVE} disabled={run !== undefined} onSelect={() => clear(session.id)}>{t('detail.clearSession')}</Item>
          </SubContent>
        </Sub>
      ))}
      {sleep.items !== null && <><Separator />{sleep.items}</>}
    </>
  );
  return { items, dialog: sleep.dialog };
}

/** A local activity's right-click (#590), on its sidebar row. */
export function LocalMenu({ activity, children }: { activity: LocalActivity; children: ReactNode }) {
  const { items, dialog } = useLocalMenu(activity, CONTEXT_KIT);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className={MENU_WIDTH}>{items}</ContextMenuContent>
      </ContextMenu>
      {dialog}
    </>
  );
}

/** A local activity's bar ⋯ (#590): the right-click's items as a dropdown, from the same list. */
export function LocalMenuButton({ activity }: { activity: LocalActivity }) {
  const { items, dialog } = useLocalMenu(activity, DROPDOWN_KIT);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t('detail.more')}><MoreHorizontalIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_WIDTH}>{items}</DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
