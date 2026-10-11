import { GitPullRequestIcon } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { activityOf, prsOf, workIdOf } from '../../activities';
import { prGroups, repoName } from '../../pull-requests';
import { liveRuns, startMode } from '../../task-runs';
import { taskLabel, isBlocked, removalBlocker, resolveWorkspace, workersOf, stageOf, inAction } from '../../tasks';
import type { Task, State, Status } from '../../types';
import { act, actThen, focusRun } from '@/components/actions';
import { taskAutoBadge } from '@/lib/auto-badge';
import { type TaskDragHandlers, dragHint } from '@/components/task-drag';
import { TaskMenu } from '@/components/TaskMenu';
import { Confirm } from '@/components/Confirm';
import { ciProgress, ciTone } from '@/components/CiProgress';
import { SyncLine } from '@/components/ForkSyncNotice';
import { commandsProgress, StageOutputButton, taskError } from '@/components/CommandsProgress';
import { SetupLogsButton } from '@/components/SetupProgress';
import { StartDialog } from '@/components/StartDialog';
import { runTab, useOpenRun, useOpenStarted } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { useTaskNavKeys } from '@/hooks/use-task-keys';
import { type MessageKey, statusText, t } from '@/i18n';
import { viaTries } from '@/lib/tries';
import { STATUS_BORDER, STATUS_TEXT } from '@/lib/status';
import { answerableActivity, backoffUntil, isExhausted, taskState } from '@/lib/task-state';
import { backoffLabel } from '@/lib/usage';
import { workspaceColor } from '@/lib/workspace-color';
import { shownSize } from '@/lib/xterm-setup';

/** abrir (#542) and the O key (#585): the task's activity, on its agent session; undefined while no agent session runs. The issue page's abrir atividade too (#757). */
export function useOpenActivity(task: Task, state: State): (() => void) | undefined {
  const openRun = useOpenRun();
  const run = liveRuns(task, state, { commands: false }).find((r) => r.kind !== 'terminal');
  return run === undefined ? undefined : () => focusRun(runTab(task, run), openRun);
}

/** The task's one button (#542). */
export type TaskAction = 'details' | 'approve' | 'open' | 'continue' | 'delete' | 'start';

/** Which button the task shows (#542), by priority: out of tries → abrir, to its details (#913); an approval no live session holds back → aprovar (#829); a live session (aguardando você
 * among them, an approval pending or not) → abrir; the stage already ran and stopped → continuar; a delete-activity stage → excluir, while
 * removalBlocker lets it run (#228); it can start → iniciar. None for a missing task (its fechar / manter), a blocked one and one with
 * nothing to run. */
export function taskAction(task: Task, state: Pick<State, 'stages' | 'workers' | 'terminals' | 'deleteActivity' | 'activities' | 'activityRecords'>): TaskAction | undefined {
  if (task.missing) return undefined;
  if (isExhausted(task, state)) return 'details';
  if (answerableActivity(task, state) !== undefined) return 'approve';
  if (workersOf(state, task).length > 0) return 'open';
  const mode = startMode(task, state);
  if (typeof mode === 'object' && mode.continue) return 'continue';
  if (mode !== 'start' && typeof mode !== 'object') return undefined; // #812: { continue: false } offers iniciar; reiniciar etapa… is in the menu
  if (stageOf(state.stages, task.stage)?.action !== 'deleteActivity') return 'start';
  return removalBlocker(task, state) === undefined ? 'delete' : undefined;
}

// details and open both read abrir on purpose (#913): the first opens the details panel, where continuar stays, the second the session
const ACTION_LABEL: Record<TaskAction, MessageKey> = {
  details: 'task.open', approve: 'approval.approve', open: 'task.open', continue: 'task.continue', delete: 'activity.delete.button', start: 'task.start',
};

type Tone = Status | 'destructive';
const TONE_BORDER: Record<Tone, string> = { ...STATUS_BORDER, destructive: 'border-destructive' };
const TONE_TEXT: Record<Tone, string> = { ...STATUS_TEXT, destructive: 'text-destructive' };
// The selected task's ring (redesign 10): its status colour at 35%, ring's with none. Literal per tone, so Tailwind's scanner finds each
const TONE_RING: Record<Tone, string> = {
  empty: 'ring-ring/35', working: 'ring-working/35', waiting: 'ring-waiting/35', review: 'ring-review/35', approval: 'ring-approval/35', backoff: 'ring-backoff/35', destructive: 'ring-destructive/35',
};

interface TaskStatus { tone?: Tone; text?: string }

const blockedText = (task: Task): string => t('task.blockedBy', { ids: (task.item.blockedBy ?? []).join(', ') });

// What the footer says (#542): in the status colour sumiu da source, then out of tries (#913), then the task's state (#663: its sessions' worst at work, else aguardando
// review, else aguardando aprovação), the precedence the border always had (#229, #268, #279); in muted the worktree setup (#351), a spawn
// error or the blocker. Nothing otherwise
function taskStatus(task: Task, state: State): TaskStatus {
  if (task.missing) return { tone: 'destructive', text: t('task.missing') };
  const error = activityOf(state, task.item.itemId)?.error;
  if (error !== undefined && isExhausted(task, state)) return { tone: 'destructive', text: taskError(error) }; // #913: halted, worse than a question
  const current = taskState(task, state);
  const live = activityOf(state, task.item.itemId); // the run fields are the live activity's (#629)
  const byAction = current === 'working' && workersOf(state, task).length === 0 && inAction(live); // #15: working is the stage action's, its progress below says which
  if (current !== 'empty' && current !== 'new' && !byAction) return { tone: current, text: current === 'backoff' ? backoffLabel(backoffUntil(task, state), Date.now()) : statusText(current) }; // #805: with the time left
  const setup = live?.setup;
  if (setup) return { text: setup.step === undefined ? t('event.starting') : t('task.setupStep', { detail: setup.step }) };
  const progress = commandsProgress(task, state); // #755: a commands stage's command, after the setup's own line
  if (progress !== undefined) return { text: progress };
  const waiting = ciProgress(task, state); // #834: a wait for CI in the working colour: the task is at work, with no worker
  if (waiting !== undefined) {
    const tone = ciTone(task, state); // #854: muted while a maintainer must act, destructive with no re-run
    return tone === undefined ? { text: waiting } : { tone, text: waiting };
  }
  if (live?.error !== undefined) return { text: taskError(live.error) }; // #755, #834: a stage action's failure in the viewer's language
  const blocked = startMode(task, state) === 'none' && isBlocked(task.item) && stageOf(state.stages, task.stage)?.action === undefined;
  return blocked ? { text: blockedText(task) } : current === 'new' ? { text: statusText('new') } : {}; // #727: new, muted
}

// The title (#134, 1b): the workspace's colour square before the id, its name as the square's title, two lines at most. No square when no rule
// resolves a workspace (#179)
function TaskTitle({ task, state }: { task: Task; state: State }) {
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces);
  return (
    <span className="line-clamp-2 font-medium text-xs leading-4">
      {workspace !== undefined && <span aria-hidden="true" title={workspace} className="mr-1.5 inline-block size-2 rounded-[2px] align-middle" style={{ background: workspaceColor(workspace) }} />}
      {taskLabel(task)}
    </span>
  );
}

// The tries the transition the task came through took (#134), `falhou · 1/3`; nothing on an arrow with no limit
function triesText(task: Task, state: State): string | undefined {
  const tries = viaTries(state, activityOf(state, task.item.itemId));
  return tries === undefined ? undefined : t('task.tries', tries);
}

// The task's PRs at a glance (#698): the own repository's stack and how much of it merged, then the PRs of other repositories. Only with a
// slice PR or PRs in several repositories: a lone PR already shows as the footer's status
function PrLine({ task, state }: { task: Task; state: State }) {
  const [own, ...others] = prGroups(prsOf(state, task.item.itemId), task.item.facets?.repository);
  if (own === undefined || (others.length === 0 && own.type === undefined)) return null;
  const stack = own.type === undefined ? [] : [`${t(`prs.type.${own.type}`)} ${t('prs.mergedShort', { x: own.merged, y: own.slices })}`];
  const more = others.length === 0 ? [] : [others.length === 1 ? t('prs.moreRepo', { n: others[0].lines.length, repo: repoName(others[0].repo) }) : t('prs.moreRepos', { n: others.length })];
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <GitPullRequestIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{[...stack, ...more].join(' · ')}</span>
    </div>
  );
}

// A missing task's fechar / manter (#182, #279), in place of the one button: nothing else acts on it
function MissingActions({ task }: { task: Task }) {
  const id = encodeURIComponent(task.item.itemId);
  return (
    <>
      <Confirm
        message={t('confirm.closeMissing')}
        confirmLabel={t('task.close')}
        trigger={<Button type="button" size="xs" variant="outline">{t('task.close')}</Button>}
        onConfirm={() => act(`/tasks/${id}/close`)}
      />
      <Button type="button" size="xs" variant="outline" onClick={() => act(`/tasks/${id}/keep`)}>{t('task.keep')}</Button>
    </>
  );
}

// The one button (#542) and the Start dialog iniciar opens on executar etapas (#543). The dialog outlives the button: its start takes a worker
// at once, so iniciar turns into abrir while the dialog still shows the worktree's setup (#351)
function TaskButton({ task, state, onOpen }: { task: Task; state: State; onOpen?(taskId: string): void }) {
  const [isStarting, setIsStarting] = useState(false);
  const opener = useOpenStarted();
  const openActivity = useOpenActivity(task, state);
  const action = taskAction(task, state);
  const id = encodeURIComponent(task.item.itemId);
  const work = `/activities/${encodeURIComponent(workIdOf(state, task.item.itemId) ?? '')}`; // the live activity, else a deleted one's record a continue resumes from (#629)
  const started = (): void => opener?.(task.item.itemId); // a run is coming: its task goes to the center once it shows (#457)
  const press: Record<TaskAction, () => void> = {
    details: () => onOpen?.(task.item.itemId),
    approve: () => void act(`${work}/approve`),
    open: () => openActivity?.(),
    continue: () => void actThen(`${work}/continue`, started, { size: shownSize() }),
    delete: () => void act(`/tasks/${id}/start`), // the stage's own git: no run to show
    start: () => setIsStarting(true),
  };
  return (
    <>
      {action && (
        <Button type="button" size="xs" variant={action === 'delete' ? 'destructive' : 'default'} onClick={press[action]}>{t(ACTION_LABEL[action])}</Button>
      )}
      {isStarting && <StartDialog state={state} taskId={task.item.itemId} initialMode="stages" onStarted={started} onClose={() => setIsStarting(false)} />}
    </>
  );
}

// A click on the task's free area opens it in the panel. Its buttons keep doing only their own thing, and a click inside a dialog one of them
// opened (portaled out of the li, yet still bubbling through React) is not the task's either. A drag fires no click.
const openOnClick = (itemId: string, onOpen?: (taskId: string) => void) => (e: MouseEvent<HTMLLIElement>): void => {
  const target = e.target as Element;
  if (!onOpen || !e.currentTarget.contains(target) || target.closest('button, a')) return;
  onOpen(itemId);
};

interface FlowTaskProps {
  task: Task; state: State; dragHandlers: TaskDragHandlers; isDimmed: boolean; isDropBefore: boolean;
  isSelected: boolean; // the task the detail panel shows (redesign 10)
  onOpen?(taskId: string): void;
}

/** A task of the flow (redesign 10, #542): the title with the workspace square, and a footer with the auto badge, the status and one button. The
 * border and the selected ring take the status colour. Drag, click-to-open and the right-click menu stay; a missing task has no menu. */
export function FlowTask({ task, state, dragHandlers, isDimmed, isDropBefore, isSelected, onOpen }: FlowTaskProps) {
  const status = taskStatus(task, state);
  const tries = triesText(task, state);
  const { tone } = status;
  const live = activityOf(state, task.item.itemId);
  const setup = live?.setup;
  const ring = isSelected ? `ring-2 ${TONE_RING[tone ?? 'empty']}` : '';
  const openActivity = useOpenActivity(task, state);
  const onKeyDown = useTaskNavKeys(task, state, onOpen, openActivity); // #585
  const item = (
    <li
      {...dragHandlers}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the search's focus operations act on it (#584); a click focuses it too
      tabIndex={0}
      data-task-id={task.item.itemId}
      data-drop={isDropBefore ? 'before' : undefined}
      aria-current={isSelected ? 'true' : undefined}
      onClick={openOnClick(task.item.itemId, onOpen)}
      onKeyDown={onKeyDown}
      title={t(dragHint(task, state))} // what a drag may do with it (#366)
      className={`relative flex cursor-grab outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 flex-col gap-[5px] rounded-lg border bg-background px-2 py-[7px] before:absolute before:inset-x-0 before:-top-1 before:hidden before:h-0.5 before:content-[''] before:bg-primary data-[drop=before]:before:block ${tone ? TONE_BORDER[tone] : ''} ${ring} ${isDimmed ? 'opacity-50' : task.orphan ? 'opacity-70' : ''}`}
    >
      <TaskTitle task={task} state={state} />
      <PrLine task={task} state={state} />
      <SyncLine task={task} state={state} /> {/* #854 */}
      {/* The approval status hides the blocker in the footer, so it gets its own line; approving still works (#595) */}
      {live?.approval && isBlocked(task.item) && <span className="truncate text-muted-foreground text-xs">⊘ {blockedText(task)}</span>}
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        {task.auto && <span className={`shrink-0 rounded-sm border px-1 font-medium ${taskAutoBadge(task, state)}`}>{t('flow.auto')}</span>}
        {status.text !== undefined && <span className={`min-w-0 truncate ${tone ? TONE_TEXT[tone] : 'text-muted-foreground'}`} title={status.text}>{status.text}</span>}
        {tries !== undefined && <span className="shrink-0 text-muted-foreground">{tries}</span>}
        {setup && <SetupLogsButton consoleId={setup.consoleId} />}
        <StageOutputButton task={task} state={state} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{task.missing ? <MissingActions task={task} /> : <TaskButton task={task} state={state} onOpen={onOpen} />}</span>
      </div>
    </li>
  );
  return task.missing ? item : <TaskMenu task={task} state={state}>{item}</TaskMenu>;
}
