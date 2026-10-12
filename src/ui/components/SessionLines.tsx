import type { ComponentProps, ReactNode } from 'react';
import { type LiveRun, sessionLabel } from '../../task-runs.js';
import { SESSION_ID_CHARS } from '../../tasks.js';
import { localWorker } from '../../local-sessions.js';
import { localActivityId } from '../../activities.js';
import { agentName, ranAgent } from '../../agents.js';
import type { AgentId, Session, Worker, Status } from '../../types.js';
import { act, continueTaskSession } from '@/components/actions';
import { stopRun, useCloseTab } from '@/components/close-tab-notice';
import { CopyToSub, useCopyHost } from '@/components/CopySession';
import { openLocalRun, openLocalSession } from '@/components/local-runs';
import { CONTEXT_KIT } from '@/components/menu-kit';
import { RUN_AGENT } from '@/components/NewRunButton';
import { AgentIcon } from '@/components/SessionLabel';
import { type SleepNoticeInput, showSleepNotice, useSleep } from '@/components/sleep-notice';
import { StatusWord } from '@/components/StatusWord';
import { useOpenRun } from '@/components/terminal-tabs';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { t } from '@/i18n';
import type { TaskActivity, TaskActivitySession } from '@/lib/activities';
import { type CopySource, keptRef, sessionPath } from '@/lib/copy-targets';

const DESTRUCTIVE = 'text-destructive focus:text-destructive';

interface SessionLineProps extends Omit<ComponentProps<'button'>, 'onClick'> { agent: AgentId; label: string; status: Status; isShown: boolean; onOpen(): void }

/** One agent session under its activity or a workspace's local entry: its agent's mark and name (#925), the session's name or id and its status, sleeping
 * while no run holds it (#614). Terminals are not listed (redesign 03). The rest of the props reach the button, so a menu's trigger can wrap it. */
export function SessionLine({ agent, label, status, isShown, onOpen, ...rest }: SessionLineProps) {
  return (
    <button
      type="button" aria-current={isShown ? 'true' : undefined} onClick={onOpen} {...rest}
      className={`flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-[3px] text-left text-xs ${isShown ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
    >
      <AgentIcon agent={agent} className="size-3.5 shrink-0" />
      <span className="shrink-0">{agentName(agent)}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      <StatusWord status={status} emptyWord="session.sleeping" />
    </button>
  );
}

interface LineMenuProps { source: CopySource; last: ReactNode; children: ReactNode }

// The right-click of a session line (#587, 6a): copiar para… › with its separator (only where the copy host is), then the line's last item.
// The sleep happens at once (#672): no dialog sits beside the menu any more
function LineMenu({ source, last, children }: LineMenuProps) {
  const hasCopy = useCopyHost() !== undefined;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-[220px]">
        <CopyToSub source={source} kit={CONTEXT_KIT} />
        {hasCopy && <ContextMenuSeparator />}
        {last}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A task's session line with its right-click menu (#587, Planning default 2): copiar para… ›, then dormir, which sleeps the run at once with
 * the sleep notice (#672). */
export function RunSessionMenu({ activity, run, children }: { activity: TaskActivity; run: LiveRun; children: ReactNode }) {
  const sleep = useSleep(activity);
  const item = <ContextMenuItem onSelect={() => sleep.one(run)}>{t('session.sleep')}</ContextMenuItem>;
  return <LineMenu source={{ taskId: activity.task.item.itemId, ptyId: run.ptyId }} last={item}>{children}</LineMenu>;
}

// A task's sleeping session (#614): a click continues it in a new run through the task's open route, whose run opens as a tab of the activity
// (#249), as the details panel's abrir does. Right-click: copiar para… ›, then limpar (the task's clear route), as a stopped local session (#587)
function SleepingLine({ activity, session }: { activity: TaskActivity; session: Session }) {
  const openRun = useOpenRun();
  const ref = keptRef(activity, session.id); // its record's: a deleted activity's kept session too (#629)
  const clear = (): void => void act(`${sessionPath(ref)}/clear`);
  return (
    <LineMenu source={ref} last={<ContextMenuItem className={DESTRUCTIVE} onSelect={clear}>{t('detail.clearSession')}</ContextMenuItem>}>
      <SessionLine agent={session.agent} label={sessionLabel(session)} status="empty" isShown={false} onOpen={() => continueTaskSession(activity.task, ref, openRun)} />
    </LineMenu>
  );
}

interface TaskSessionLineProps { activity: TaskActivity; entry: TaskActivitySession; shown?: string; onOpenRun(ptyId: string): void }

/** One session of a task's activity (#614): a live one opens its run's tab and keeps dormir in its menu; a sleeping one is continued. `shown` is
 * the run the center shows while this activity is the selected one. */
export function TaskSessionLine({ activity, entry, shown, onOpenRun }: TaskSessionLineProps) {
  const { session, run, status } = entry;
  if (run !== undefined) {
    const target = run.terminalId ?? run.ptyId; // #696: a captured session's run lives in its terminal's pty: its line opens the terminal
    return (
      <RunSessionMenu activity={activity} run={run}>
        <SessionLine agent={ranAgent(run)} label={run.session ?? ''} status={status} isShown={target === shown} onOpen={() => onOpenRun(target)} />
      </RunSessionMenu>
    );
  }
  return session === undefined ? null : <SleepingLine activity={activity} session={session} />;
}

interface LocalLineProps { workspace: string; session: Session; worker?: Worker; shown?: string }

// One local session (#587, Planning default 3): a live line opens its run's window, a stopped one reads sleeping (#614) and continues it.
// Right-click: copiar para… ›, then dormir (live, at once with the sleep notice, #672) or limpar (stopped)
function LocalLine({ workspace, session, worker, shown }: LocalLineProps) {
  const openRun = useOpenRun();
  const settings = useCloseTab();
  const label = session.name ?? session.id.slice(0, SESSION_ID_CHARS);
  const ptyId = worker?.runId;
  const target = worker?.terminalId ?? ptyId; // #696: a captured session opens its terminal
  const onOpen = (): void => openLocalSession(workspace, session, worker, openRun);
  const ref = { activityId: localActivityId(workspace), sessionId: session.id }; // #629
  const clear = (): void => void act(`${sessionPath(ref)}/clear`);
  const sleep = (id: string): void => {
    const input: SleepNoticeInput = { cause: 'manual', where: t('activities.local'), sessions: [{ ptyId: id, session: label }], onContinue: () => openLocalRun(workspace, RUN_AGENT, openRun, { continueId: session.id }) };
    void stopRun(id).then((isAsleep) => { if (isAsleep) showSleepNotice(input, settings); });
  };
  const last = ptyId === undefined
    ? <ContextMenuItem className={DESTRUCTIVE} onSelect={clear}>{t('detail.clearSession')}</ContextMenuItem>
    : <ContextMenuItem onSelect={() => sleep(ptyId)}>{t('session.sleep')}</ContextMenuItem>;
  return (
    <LineMenu source={ref} last={last}>
      <SessionLine agent={session.agent} label={label} status={worker?.status ?? 'empty'} isShown={target !== undefined && target === shown} onOpen={onOpen} />
    </LineMenu>
  );
}

/** A workspace's local sessions under its local activity (#587, #590), oldest first: the name or the short id, and the status while the run
 * lives; `shown`, the run the center shows while the local activity is the selected one, is marked. */
export function LocalSessionLines({ workspace, sessions, workers, shown }: { workspace: string; sessions: Session[]; workers: Worker[]; shown?: string }) {
  return sessions.map((session) => <LocalLine key={session.id} workspace={workspace} session={session} worker={localWorker(workers, workspace, session.id)} shown={shown} />);
}
