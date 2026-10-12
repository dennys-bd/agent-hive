import { PlusIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useRef } from 'react';
import { agentName, ALL_AGENTS, isAvailable } from '../../agents';
import { nextPr } from '../../pull-requests';
import { canDiff } from '../../task-runs';
import { type Activity as LiveActivity, AGENT_IDS, type AgentAvailability, type AgentId, type Task, type TaskPr, DEFAULT_AGENT, type DiffScope, type OpenResult, type OperationId } from '../../types';
import { act, attachRun } from '@/components/actions';
import { KeyHint } from '@/components/KeyHint';
import { openLocalRun } from '@/components/local-runs';
import { type OpenDiff, type OpenRun, useOpenDiff, useOpenPr, useOpenRun } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { canOpenIn, type RunTarget, type TaskActivity } from '@/lib/activities';
import { onShortcutKey } from '@/lib/dock-layout';
import { shownSize } from '@/lib/xterm-setup';

/** What a new run opens (#491, #536): a terminal, or an agent's new session. */
export type NewRunKind = 'terminal' | AgentId;

export { agentName } from '../../agents';

/** The handoff's segmented control inside a menu (#536): a muted track, the checked segment in the page's background. The track and accent
 * share a colour, so the keyboard's focus shows as a ring instead of a fill. */
export const SEGMENT_TRACK = 'mx-2 mb-1.5 flex rounded-md bg-muted p-0.5';
export const SEGMENT = 'flex-1 justify-center py-0.5 font-medium text-[13px] focus:bg-transparent focus-visible:ring-1 focus-visible:ring-ring data-[state=checked]:bg-background data-[state=checked]:focus:bg-background';

/** The config's defaultAgent (#516), which the newSession key opens (#536): App provides it from the settings info the page already reads. */
export const DefaultAgentContext = createContext<AgentId>(DEFAULT_AGENT);

/** The agents boot found (#516), SettingsInfo.agents: App provides them; every agent until it does (#931). */
export const AgentsContext = createContext<readonly AgentAvailability[]>(ALL_AGENTS);

/** An agent as every menu that opens a session lists it (#931): all of them, one boot did not find disabled and named as AgentSelect names it. */
export interface AgentPick { agent: AgentId; label: string; disabled: boolean }

export const agentPicks = (agents: readonly AgentAvailability[]): AgentPick[] => AGENT_IDS.map((agent) => {
  const isOn = isAvailable(agent, agents);
  return { agent, label: isOn ? agentName(agent) : `${agentName(agent)} · ${t('settings.agent.offPath')}`, disabled: !isOn };
});

/** agentPicks of the agents App provides. */
export const useAgentPicks = (): AgentPick[] => agentPicks(useContext(AgentsContext));

// The diff the + offers (#591): the stage's while it has a recorded start, else the worktree's; none without a worktree
const diffScopeOf = (task: Task, activity: LiveActivity | undefined): DiffScope | undefined =>
  (canDiff(task, activity, 'stage') ? 'stage' : canDiff(task, activity, 'worktree') ? 'worktree' : undefined);

/** The + menu's keys (#536): newSession opens the default agent's new session and openDiff the + menu's diff, in the shown activity. Mounted
 * with the center, once, so they act only while an activity shows; each does nothing where its item would be disabled. */
export function useNewRunKeys(target: RunTarget): void {
  const openRun = useOpenRun();
  const openDiff = useOpenDiff();
  const agent = useContext(DefaultAgentContext);
  const agents = useContext(AgentsContext);
  const latest = useRef<Record<'session' | 'diff', () => void>>({ session: () => undefined, diff: () => undefined });
  useEffect(() => {
    latest.current = {
      session: () => { if (canOpenIn(target) && isAvailable(agent, agents)) openNew(target, agent, openRun); }, // #931: nothing where its item is disabled
      diff: () => startEntry(target, 'diff', openRun, openDiff),
    };
  });
  useEffect(() => onShortcutKey([['session', 'newSession'], ['diff', 'openDiff']] as const, (action) => latest.current[action]()), []);
}

// POST /activities/:id/open with no resume and no base (#491): the task already has its worktree or runs in the checkout, since it has a live
// run, so Abrir sessão's questions never apply. A refusal is act's toast; a spawn failure answers no run and opens nothing (#292). onRun
// hears the run once it is opened, so the split menu can land its tab (#536); onNoRun hears neither came, so a waking tab lets go (#931). A
// local activity's opens in its workspace's checkout (#590).
export function openNew(target: RunTarget, kind: NewRunKind, openRun?: OpenRun, onRun?: (ptyId: string) => void, onNoRun?: () => void): void {
  if (target.kind === 'local') {
    openLocalRun(target.workspace, kind, openRun, { onRun, onNoRun });
    return;
  }
  const { task } = target;
  void act<OpenResult>(`/activities/${encodeURIComponent(target.activity.id)}/open`, { kind, size: shownSize() }).then((result) => {
    if (!result?.ptyId) return void onNoRun?.();
    attachRun(result, task, kind === 'terminal' ? 'terminal' : 'session', openRun);
    onRun?.(result.ptyId);
  });
}

/** One way to start a run in an activity (#759): what the + menu lists before its PR and file items, and what the activity's home shows as
 * its buttons, so the two never drift. `disabled` where the + is (canOpenIn), and the diff also with no worktree to diff. */
export interface NewRunEntry { kind: NewRunKind | 'diff'; label: string; key?: OperationId; disabled: boolean }

/** The new-run entries of an activity (#759): terminal, each agent (the default one carries newSession's key; one off PATH disabled, #931)
 * and, on a task's, its diff. */
export function newRunEntries(target: RunTarget, defaultAgent: AgentId, agents: readonly AgentAvailability[]): NewRunEntry[] {
  const isClosed = !canOpenIn(target);
  const sessions = agentPicks(agents).map(({ agent, label, disabled }): NewRunEntry => ({ kind: agent, label, key: agent === defaultAgent ? 'newSession' : undefined, disabled: isClosed || disabled }));
  const diff: NewRunEntry[] = target.kind === 'task'
    ? [{ kind: 'diff', label: t('activity.new.diff'), key: 'openDiff', disabled: isClosed || diffScopeOf(target.task, target.activity) === undefined }]
    : [];
  return [{ kind: 'terminal', label: t('activities.menu.terminal'), key: 'newTerminal', disabled: isClosed }, ...sessions, ...diff];
}

/** An entry's pick (#759): a run opened as the + opens it, or the task's diff, the stage's while it has a recorded start, else the worktree's
 * (#591). The menu, the home's buttons and the openDiff key all go through here. */
export function startEntry(target: RunTarget, kind: NewRunEntry['kind'], openRun?: OpenRun, openDiff?: OpenDiff): void {
  if (kind !== 'diff') {
    openNew(target, kind, openRun);
    return;
  }
  const scope = target.kind === 'task' ? diffScopeOf(target.task, target.activity) : undefined; // a local activity has no worktree to diff (#590)
  if (target.kind === 'task' && scope !== undefined) openDiff?.(target.task, scope);
}

// agente abre como · em breve: an agent opens in its terminal only until a chat view exists, so the toggle shows the choice locked on terminal
function OpensAs() {
  return (
    <>
      <DropdownMenuLabel>{`${t('activity.new.opensAs')} · ${t('split.soon')}`}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value="terminal" className={SEGMENT_TRACK}>
        <DropdownMenuRadioItem value="chat" disabled className={SEGMENT}>{t('activity.new.chat')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="terminal" className={SEGMENT} onSelect={(event) => event.preventDefault()}>{t('activities.menu.terminal')}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </>
  );
}

// The +'s title (#536, #590): a task's short reference (taskLabel's head: the title would not fit 220px), or a local activity's workspace
export const referenceOf = (target: RunTarget): string => (target.kind === 'local' ? target.workspace : `${target.task.created ? '' : '#'}${target.task.item.id}`);

// mostrar PR (#592, #698, #758): the page of the task's next PR to merge; disabled while it has none
function PrItem({ task, prs }: { task: Task; prs: TaskPr[] }) {
  const openPr = useOpenPr();
  const url = nextPr(prs, task.item.facets?.repository);
  return <DropdownMenuItem disabled={url === undefined} onSelect={() => { if (url !== undefined) openPr?.(url); }}>{t('task.showPr')}</DropdownMenuItem>;
}

/** The activity center's + (#491, redesign 04): a 220px menu titled with the task's reference (the handoff's HIVE-11), a terminal (with the
 * newTerminal key, which opens one in the shown activity) or a new session of each agent, opened at once as a new tab of this center through
 * the run opener (#457); the stage's diff, else the worktree's (#270, #591), the task's PR (#592); an untitled file (#818), enabled where the center gives onNewFile; and how an agent opens. Resuming a session stays in the
 * task's menu and the sidebar. Disabled by the rule Abrir sessão reads, so both agree; on the trigger, so Radix neither shows the button
 * enabled nor opens the menu. A local activity's + is titled with its workspace and has no diff item (#590). */
export function NewRunButton({ activity, onNewFile }: { activity: RunTarget & Partial<Pick<TaskActivity, 'records'>>; onNewFile?(): void }) {
  const openRun = useOpenRun();
  const openDiff = useOpenDiff();
  const defaultAgent = useContext(DefaultAgentContext);
  const agents = useContext(AgentsContext);
  const task = activity.kind === 'task' ? activity.task : undefined; // the PR item is a task's (#592)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!canOpenIn(activity)}>
        <Button type="button" size="icon" variant="ghost" className="h-full w-[34px] rounded-none data-[state=open]:bg-accent" aria-label={t('activity.new')}><PlusIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel>{t('activity.new.title', { task: referenceOf(activity) })}</DropdownMenuLabel>
        {newRunEntries(activity, defaultAgent, agents).map((entry) => (
          <DropdownMenuItem key={entry.kind} disabled={entry.disabled} onSelect={() => startEntry(activity, entry.kind, openRun, openDiff)}>
            {entry.label}{entry.key && <KeyHint id={entry.key} />}
          </DropdownMenuItem>
        ))}
        {task && <PrItem task={task} prs={activity.records?.flatMap((r) => r.prs ?? []) ?? []} />}
        <DropdownMenuItem disabled={onNewFile === undefined} onSelect={() => onNewFile?.()}>{t('activity.new.file')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <OpensAs />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
