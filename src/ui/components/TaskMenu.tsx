import { CheckIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { canDiff, canRunCommand, commandsOf, liveCommand, openFeedbackSession, startMode } from '../../task-runs';
import { canMoveToStage, canOpenSession, canSetWorkspace, createdRemovalBlocker, resolveWorkspace, type Runs } from '../../tasks';
import { nextPr } from '../../pull-requests';
import { activityOf, prsOf } from '../../activities';
import type { Task, State } from '../../types';
import { act, runCommand, stageMoves } from '@/components/actions';
import { FeedbackDialog } from '@/components/ApprovalActions';
import { Confirm } from '@/components/Confirm';
import { AutoStartItem, deleteActivityMessage } from '@/components/DetailMenu';
import { CONTEXT_KIT, type MenuKit } from '@/components/menu-kit';
import { DeleteActivity, deletionBlocker, taskDeletionUrl } from '@/components/DeleteActivity';
import { DecompositionDialog } from '@/components/DecompositionDialog';
import { RestartDialog } from '@/components/RestartDialog';
import { useCommandStop } from '@/components/RunCommands';
import { StartDialog } from '@/components/StartDialog';
import type { StartMode } from '@/components/StartFields';
import { useSleepMenu } from '@/components/SleepMenu';
import { useOpenDiff, useOpenPr, useOpenStarted } from '@/components/terminal-tabs';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useOpenConsole } from '@/hooks/use-console';
import { useTaskMenuKeys } from '@/hooks/use-task-keys';
import { type MessageKey, t } from '@/i18n';
import { activitiesOf } from '@/lib/activities';
import { answerableActivity } from '@/lib/task-state';

const DESTRUCTIVE = 'text-destructive focus:text-destructive';
const NOTE = 'px-2 py-1.5 text-muted-foreground text-xs';

/** The flow's scroll row (#542): the task menu's collision boundary, so Radix flips the menu inward instead of over the detail panel.
 * Null outside a Flow (a component test): the viewport, Radix's default. */
export const MenuBoundaryContext = createContext<HTMLElement | null>(null);

// executar › (#300, redesign 10): 200px, headed by the workspace's name, the commands of the task's workspace, then the note that their
// output goes to the console; absent when it has none. A start is disabled until the task has a worktree on disk (the route answers 409 then)
// and shows the console on the run (#353). A command live on the task reads Parar <nome>, its Confirm beside the menu as useSleepMenu's is. The
// trigger stays enabled while a command runs, so its Stop is reachable after the worktree went. Rendered with the caller's kit (#536).
export function useRunMenu(task: Task, state: State, kit: MenuKit = CONTEXT_KIT): { items: ReactNode; dialog: ReactNode } {
  const openConsole = useOpenConsole();
  const stop = useCommandStop();
  const runnable = canRunCommand(task, activityOf(state, task.item.itemId));
  const commands = commandsOf(task, state).map((name) => ({ name, live: liveCommand(task, state, name) }));
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks) ?? ''; // commandsOf answers none without one
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;
  const items = commands.length > 0 && (
    <Sub>
      <SubTrigger disabled={!runnable && commands.every((c) => c.live === undefined)}>{t('task.run')}</SubTrigger>
      <SubContent className="w-[200px]">
        <p className={NOTE}>{t('task.commandsOf', { workspace })}</p>
        {commands.map(({ name, live }) => (live === undefined
          ? <Item key={name} disabled={!runnable} onSelect={() => runCommand(task, state, name, openConsole)}>{name}</Item>
          : <Item key={name} onSelect={() => stop.ask(live)}>{t('command.stop', { name })}</Item>))}
        <Separator />
        <p className={NOTE}>{t('task.commandsNote')}</p>
      </SubContent>
    </Sub>
  );
  return { items, dialog: stop.dialog };
}

const DIFF_SCOPES = ['stage', 'worktree'] as const; // the menu keeps its two items; the pane's picker offers the commit scope (#591)
const DIFF_ITEM_KEY: Record<(typeof DIFF_SCOPES)[number], MessageKey> = { stage: 'task.diffStage', worktree: 'task.diffWorktree' };

// Right-click › Diff da etapa / Diff da worktree (#270): what the current stage, or the whole worktree, changed, as a tab of the task's
// activity (#458). Disabled while the task is no activity (there is no terminal panel to take it since redesign 07), and while canDiff says
// no (no worktree on disk; for the stage, no start recorded in the current stage), as the route answers 409 then. A second click on an open
// one shows its tab. Then mostrar PR (#592, #758): the page of the task's next PR to merge (#698), disabled while it has none.
export function DiffItems({ task, state, kit = CONTEXT_KIT }: { task: Task; state: State; kit?: MenuKit }) {
  const openDiff = useOpenDiff();
  const openPr = useOpenPr();
  const url = nextPr(prsOf(state, task.item.itemId), task.item.facets?.repository);
  const { Item } = kit;
  const isActivity = activitiesOf(state).some((activity) => activity.kind === 'task' && activity.task.item.itemId === task.item.itemId);
  return (
    <>
      {DIFF_SCOPES.map((scope) => (
        <Item key={scope} disabled={!isActivity || !canDiff(task, activityOf(state, task.item.itemId), scope)} onSelect={() => openDiff?.(task, scope)}>{t(DIFF_ITEM_KEY[scope])}</Item>
      ))}
      <Item disabled={url === undefined} onSelect={() => { if (url !== undefined) openPr?.(url); }}>{t('task.showPr')}</Item>
    </>
  );
}

/** aprovar and enviar feedback…, then a separator, only while the approval is the user's to answer (#268, #829): every awaiting task takes
 * feedback, manual gates included (#685), and none while a session of it is live, where the user answers. The task's and the activity's menus
 * render it, each with its kit. */
export function ApprovalItems({ task, state, kit, onFeedback }: { task: Task; state: State; kit: MenuKit; onFeedback(): void }) {
  const live = answerableActivity(task, state); // the approval and its route are the live activity's (#629)
  if (!live) return null;
  const { Item, Separator } = kit;
  return (
    <>
      <Item onSelect={() => act(`/activities/${encodeURIComponent(live.id)}/approve`)}>{t('approval.approve')}</Item>
      <Item onSelect={onFeedback}>{t('task.sendFeedback')}</Item>
      <Separator />
    </>
  );
}

/** excluir atividade… (#542, the glossary's delete activity): the task's worktree and branch go, the task stays, through the delete-activity
 * route and its confirm (#182, #236). Disabled with the reason while removalBlocker answers (#210); absent on a local task, which has no
 * worktree of its own (#444). The task's menu and the activity's share it; the confirm goes beside the caller's menu. */
export function useDeleteActivity(task: Task, state: State, { Item }: MenuKit = CONTEXT_KIT): { item: ReactNode; dialog: ReactNode } {
  const [isDeleting, setIsDeleting] = useState(false);
  if (activityOf(state, task.item.itemId)?.local) return { item: null, dialog: null };
  const blocker = deletionBlocker(task, state);
  const label = t('activity.delete');
  const item = (
    <Item className={DESTRUCTIVE} disabled={blocker !== undefined} onSelect={() => setIsDeleting(true)}>
      {blocker ? `${label} · ${t(`detail.deleteActivityBlocked.${blocker}`)}` : label}
    </Item>
  );
  const dialog = (
    <DeleteActivity url={taskDeletionUrl(task, state)} message={deleteActivityMessage(task, state)} available confirm={{ open: isDeleting, onOpenChange: setIsDeleting }} />
  );
  return { item, dialog };
}

// excluir task… (#355, #542): a Hive task only (#132), disabled with the reason while createdRemovalBlocker answers. Its confirm, beside the
// menu for useSleepMenu's reason, says the worktree and the branch go too: POST close removes them before the task (server-tasks.ts)
function useDeleteTask(task: Task, runs: Runs): { item: ReactNode; dialog: ReactNode } {
  const [isConfirming, setIsConfirming] = useState(false);
  if (!task.created) return { item: null, dialog: null };
  const blocker = createdRemovalBlocker(task, runs);
  const label = t('task.delete');
  const item = (
    <ContextMenuItem className={DESTRUCTIVE} disabled={blocker !== undefined} onSelect={() => setIsConfirming(true)}>
      {blocker ? `${label} · ${t(`detail.deleteActivityBlocked.${blocker}`)}` : label}
    </ContextMenuItem>
  );
  const dialog = isConfirming && (
    <Confirm
      open
      onOpenChange={(open) => { if (!open) setIsConfirming(false); }}
      title={t('confirm.title.deleteTask')}
      message={t('confirm.removeLocal')}
      confirmLabel={t('task.delete.confirm')}
      onConfirm={() => void act(`/tasks/${encodeURIComponent(task.item.itemId)}/close`)}
    />
  );
  return { item, dialog };
}

// mover para etapa › (#164, #366, #708): on every task, auto on or off, disabled while canMoveToStage refuses (a stage run holds it, or it
// is leaving); the drag shares canMoveToStage; its items are stageMoves', which the exhausted block's mover para… lists too (#916)
function StageSub({ task, state }: { task: Task; state: State }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={!canMoveToStage(task, state)}>{t('task.moveToStage')}</ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {stageMoves(task, state).map(({ stage, move }) => <ContextMenuItem key={stage} onSelect={move}>{stage}</ContextMenuItem>)}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

// mover para workspace › (#179, redesign 10): the Comb's workspaces, the one the task resolves to checked. While canSetWorkspace says no it is
// disabled with the reason on a second line: the worktree, its branch and its sessions live in the current repo
function WorkspaceSub({ task, state, id }: { task: Task; state: State; id: string }) {
  const current = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks);
  const settable = canSetWorkspace(task, state);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={!settable}>
        <span className="flex flex-col">
          {t('task.moveToWorkspace')}
          {!settable && <span className="text-muted-foreground text-xs">{t('task.moveToWorkspace.locked')}</span>}
        </span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {state.workspaces.map((p) => (
          <ContextMenuItem key={p} aria-current={p === current ? 'true' : undefined} onSelect={() => act(`/tasks/${id}/workspace`, { workspace: p })}>
            <CheckIcon className={`size-4 ${p === current ? 'opacity-100' : 'opacity-0'}`} />
            {p}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** Right-click on a task still in the flow (redesign 10, #542), 236px, in the handoff's order: aprovar and enviar feedback… while the stage
 * awaits approval (#268, #315); executar etapas… and abrir sessão livre…, the Start dialog on the task in either mode (#543), disabled while
 * canOpenSession says no; reiniciar etapa…, today's restart dialog, only when startMode offers it (#283); executar › (#300) and dormir › (the
 * task's agent sessions, #343); the two diffs (#270); começar sozinho, mover para etapa › and mover para workspace ›; excluir atividade… and,
 * on a Hive task, excluir task…. Every dialog and confirm lives beside the menu, which closes on the pick, so a click in them never reaches
 * the task. */
export function TaskMenu({ task, state, children }: { task: Task; state: State; children: ReactNode }) {
  const [dialog, setDialog] = useState<StartMode | 'restart'>();
  const [feedback, setFeedback] = useState(false);
  const [isCreatingIssues, setIsCreatingIssues] = useState(false); // #865: A's confirm
  const opener = useOpenStarted();
  const boundary = useContext(MenuBoundaryContext);
  const { items: sleepItems, dialog: sleepDialog } = useSleepMenu(task, state);
  const { items: runItems, dialog: runDialog } = useRunMenu(task, state);
  const deleteActivity = useDeleteActivity(task, state);
  const deleteTask = useDeleteTask(task, state);
  const id = encodeURIComponent(task.item.itemId);
  const mode = startMode(task, state);
  const started = (taskId: string): void => opener?.(taskId); // the run's task goes to the center once it shows (#457)
  const close = (): void => setDialog(undefined);
  const live = activityOf(state, task.item.itemId);
  const onKeyDown = useTaskMenuKeys(task, state, { start: setDialog, decomposition: () => setIsCreatingIssues(true) }); // the letters (#585); F is the face's: it opens the details
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild onKeyDown={onKeyDown}>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-[236px]" collisionBoundary={boundary ?? undefined}>
          <ApprovalItems task={task} state={state} kit={CONTEXT_KIT} onFeedback={() => setFeedback(true)} />
          <ContextMenuItem disabled={!canOpenSession(task, live)} onSelect={() => setDialog('stages')}>{t('activities.menu.runStages')}</ContextMenuItem>
          <ContextMenuItem disabled={!canOpenSession(task, live)} onSelect={() => setDialog('free')}>{t('task.freeSession')}</ContextMenuItem>
          {typeof mode === 'object' && mode.restart && <ContextMenuItem onSelect={() => setDialog('restart')}>{t('task.restartStage')}</ContextMenuItem>}
          {runItems}
          {sleepItems}
          <ContextMenuSeparator />
          <DiffItems task={task} state={state} />
          <ContextMenuSeparator />
          <AutoStartItem task={task} kit={CONTEXT_KIT} />
          <StageSub task={task} state={state} />
          <WorkspaceSub task={task} state={state} id={id} />
          {(deleteActivity.item || deleteTask.item) && <ContextMenuSeparator />}
          {deleteActivity.item}
          {deleteTask.item}
        </ContextMenuContent>
      </ContextMenu>
      {(dialog === 'stages' || dialog === 'free') && <StartDialog state={state} taskId={task.item.itemId} initialMode={dialog} onStarted={started} onClose={close} />}
      {dialog === 'restart' && <RestartDialog task={task} state={state} onStarted={() => started(task.item.itemId)} onClose={close} />}
      {feedback && <FeedbackDialog activity={answerableActivity(task, state)} openSession={openFeedbackSession(task, state) !== undefined} onClose={() => setFeedback(false)} />}
      {isCreatingIssues && live && <DecompositionDialog activityId={live.id} onClose={() => setIsCreatingIssues(false)} />}
      {sleepDialog}
      {runDialog}
      {deleteActivity.dialog}
      {deleteTask.dialog}
    </>
  );
}
