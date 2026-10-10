import { MoreHorizontalIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { activityOf } from '../../activities';
import { openFeedbackSession, startMode } from '../../task-runs';
import { canOpenSession, stageOf } from '../../tasks';
import { type Activity, AGENT_IDS, type Task, type State } from '../../types';
import { FeedbackDialog } from '@/components/ApprovalActions';
import { ApprovalItems, DiffItems, useDeleteActivity, useRunMenu } from '@/components/TaskMenu';
import { CONTEXT_KIT, DROPDOWN_KIT, type MenuKit } from '@/components/menu-kit';
import { agentName, openNew } from '@/components/NewRunButton';
import { StartDialog } from '@/components/StartDialog';
import { useSleepMenu } from '@/components/SleepMenu';
import { useOpenRun, useOpenStarted } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { answerableActivity } from '@/lib/task-state';

const MENU_WIDTH = 'w-[236px]';

// executar etapas…: the Start dialog on executar etapas (redesign 11), which starts the stage or continues it on startMode's rule, so it
// agrees with the flow task's buttons. Disabled while the stage runs, awaits approval, or has nothing to run
function useRunStages(task: Task, state: State, { Item }: MenuKit): { item: ReactNode; dialog: ReactNode } {
  const [isStarting, setIsStarting] = useState(false);
  const opener = useOpenStarted();
  const mode = startMode(task, state);
  const hasPrompt = stageOf(state.stages, task.stage)?.action === undefined; // a delete activity stage is git's, not the agent's
  const canContinue = typeof mode === 'object' && mode.live === undefined;
  const item = <Item disabled={!hasPrompt || (mode !== 'start' && !canContinue)} onSelect={() => setIsStarting(true)}>{t('activities.menu.runStages')}</Item>;
  const dialog = isStarting && (
    <StartDialog state={state} taskId={task.item.itemId} onStarted={(id) => opener?.(id)} onClose={() => setIsStarting(false)} />
  );
  return { item, dialog };
}

// nova sessão ›: an agent's free session (one item per agent, as the + and dividir list them) or a terminal, opened at once as a tab of the
// activity (#491); a run target is a live activity (#629), so a task whose activity is gone has none to offer
function NewSessionSub({ task, activity, kit }: { task: Task; activity?: Activity; kit: MenuKit }) {
  const openRun = useOpenRun();
  const { Item, Sub, SubTrigger, SubContent } = kit;
  return (
    <Sub>
      <SubTrigger disabled={!activity || !canOpenSession(task, activity)}>{t('activities.menu.newSession')}</SubTrigger>
      <SubContent>
        {AGENT_IDS.map((agent) => <Item key={agent} onSelect={() => activity && openNew({ kind: 'task', task, activity }, agent, openRun)}>{agentName(agent)}</Item>)}
        <Item onSelect={() => activity && openNew({ kind: 'task', task, activity }, 'terminal', openRun)}>{t('activities.menu.terminal')}</Item>
      </SubContent>
    </Sub>
  );
}

interface ActivityMenuView { items: ReactNode; dialogs: ReactNode }

// An activity's items (redesign 03) rendered with `kit`, and the dialogs they open, which the caller puts beside its menu: the menu closes on
// the pick and would unmount a dialog inside it. The right-click and the bar's ⋯ render this one list (#536)
function useActivityMenu(task: Task, state: State, onShowFlow: () => void, kit: MenuKit): ActivityMenuView {
  const [feedback, setFeedback] = useState(false);
  const { items: runItems, dialog: runDialog } = useRunMenu(task, state, kit);
  const { items: sleepItems, dialog: sleepDialog } = useSleepMenu(task, state, { kit });
  const stages = useRunStages(task, state, kit);
  const remove = useDeleteActivity(task, state, kit); // excluir atividade… (#542): the task stays in the flow
  const { Item, Separator } = kit;
  const items = (
    <>
      <ApprovalItems task={task} state={state} kit={kit} onFeedback={() => setFeedback(true)} />
      <NewSessionSub task={task} activity={activityOf(state, task.item.itemId)} kit={kit} />
      {runItems}
      {stages.item}
      <Separator />
      <DiffItems task={task} state={state} kit={kit} />
      <Separator />
      <Item onSelect={onShowFlow}>{t('detail.showFlow')}</Item>
      {(sleepItems || remove.item) && <Separator />}
      {sleepItems}
      {remove.item}
    </>
  );
  const dialogs = (
    <>
      {remove.dialog}
      {feedback && <FeedbackDialog activity={answerableActivity(task, state)} openSession={openFeedbackSession(task, state) !== undefined} onClose={() => setFeedback(false)} />}
      {stages.dialog}
      {sleepDialog}
      {runDialog}
    </>
  );
  return { items, dialogs };
}

interface ActivityMenuProps { task: Task; state: State; onShowFlow(): void; children: ReactNode }

/** An activity's right-click (redesign 03): nova sessão, executar (the workspace's commands, #300), executar etapas…, the two diffs (#270),
 * ver no fluxo, then dormir (its agent sessions, #672) and excluir atividade… in the destructive colour (#542). Deleting the activity drops it from the list; the task
 * stays in the flow. The dialogs and confirms live beside the menu, which closes on the pick. */
export function ActivityMenu({ task, state, onShowFlow, children }: ActivityMenuProps) {
  const menu = useActivityMenu(task, state, onShowFlow, CONTEXT_KIT);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className={MENU_WIDTH}>{menu.items}</ContextMenuContent>
      </ContextMenu>
      {menu.dialogs}
    </>
  );
}

/** The activity bar's ⋯ (redesign 04, #536): the right-click's items as a dropdown, from the same list. */
export function ActivityMenuButton({ task, state, onShowFlow }: Omit<ActivityMenuProps, 'children'>) {
  const menu = useActivityMenu(task, state, onShowFlow, DROPDOWN_KIT);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t('detail.more')}><MoreHorizontalIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_WIDTH}>{menu.items}</DropdownMenuContent>
      </DropdownMenu>
      {menu.dialogs}
    </>
  );
}
