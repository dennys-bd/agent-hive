import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LiveRun } from '../../task-runs';
import { useConfirmLoss } from '@/components/AgentLossConfirm';
import { sleepTerminal } from '@/components/close-tab-notice';
import { KeyHint } from '@/components/KeyHint';
import { ranAgent } from '../../agents';
import { agentName } from '@/components/NewRunButton';
import { useSleep, waitsForCi } from '@/components/sleep-notice';
import { asksBeforeSleepAll, SleepAllConfirm } from '@/components/SleepMenu';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import { onShortcutKey } from '@/lib/dock-layout';

interface SleepButtonProps { activity: Activity; focusedRun?: string } // its live runs leave a run command out (#353): a task's or a local activity's (#590)
interface SessionsMenuProps { agents: LiveRun[]; focusedRun?: string; isDisabled: boolean; onSleep(run: LiveRun): void; onSleepAll(): void }

// The ⌄ (1f): each live agent session named as the sidebar's session lines are, em foco on the focused one, then dormir todas with its key,
// which sleeps the activity's terminals too (#696). Enabled while anything of the activity is live. Outline, as the button: sleeping loses
// nothing (#672)
function SessionsMenu({ agents, focusedRun, isDisabled, onSleep, onSleepAll }: SessionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={isDisabled}>
        <Button type="button" size="xs" variant="outline" className="rounded-l-none border-l-0 px-1" aria-label={t('activity.stop.pick')}>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[236px]">
        <DropdownMenuLabel>{t('activity.stop.sessions', { n: agents.length })}</DropdownMenuLabel>
        {agents.map((run) => (
          <DropdownMenuItem key={run.ptyId} onSelect={() => onSleep(run)}>
            <span className="shrink-0">{agentName(ranAgent(run))}</span>
            <span className="min-w-0 truncate font-mono">{run.session ?? ''}</span>
            {run.ptyId === focusedRun && <span className="ml-auto text-muted-foreground text-xs">{t('activity.stop.focused')}</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSleepAll}>{t('sleep.all')}<KeyHint id="sleepAll" /></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The activity bar's dormir (1f, #536, #672): an outline split button. Its text sleeps the focused group's shown agent session at once, with
 * the sleep notice; a focused terminal sleeps as its tab's close does (#696), at once, or after the agent confirm when an agent the shim missed
 * runs in it (a run command's run is never listed here: its own item stops it); it is disabled while that
 * group shows a diff or the console. Its ⌄ sleeps one agent session at once, or opens dormir todas, which takes the terminals too (#696). While mounted (only with an activity in
 * the center) it answers the sleepSession key with the focused session's sleep (a focused terminal is no session) and the sleepAll key with
 * dormir todas: its dialog on several sessions, the one at once. A wait for CI (#834) is ended by dormir when no run is focused, and by
 * dormir todas. */
export function SleepButton({ activity, focusedRun }: SleepButtonProps) {
  const sleep = useSleep(activity);
  const [pending, setPending] = useState<LiveRun[]>(); // dormir todas' dialog
  const loss = useConfirmLoss(); // #696: a focused terminal's sleep asks it when an agent the shim missed runs there
  const all = activity.runs; // its agent sessions and its terminals (#696); a run command left out
  const agents = all.filter((run) => run.kind !== 'terminal');
  const focused = all.find((run) => run.ptyId === focusedRun);
  const isTerminal = focused?.kind === 'terminal';
  const isWaiting = waitsForCi(activity); // #834: a wait for CI, a stage run with no pty
  const sleepAll = (): void => {
    if (asksBeforeSleepAll(all)) setPending(all);
    else if (all.length === 1 || isWaiting) sleep.all(all);
  };
  // The keys' listener subscribes once and reads the latest render's runs: with no agent session, or a terminal in focus, a key does nothing
  const keys = useRef<Record<'all' | 'one', () => void>>({ all: () => undefined, one: () => undefined });
  useEffect(() => {
    keys.current = { all: sleepAll, one: () => { if (focused !== undefined && !isTerminal) sleep.one(focused); } };
  });
  useEffect(() => onShortcutKey<'all' | 'one'>([['all', 'sleepAll'], ['one', 'sleepSession']], (which) => keys.current[which]()), []);
  const onMain = (): void => {
    if (focused === undefined) {
      if (isWaiting) sleep.ci(); // #834: no run in focus: the wait is what runs
      return;
    }
    if (isTerminal) sleepTerminal(focused.ptyId, loss.confirm);
    else sleep.one(focused);
  };
  return (
    <>
      <div className="flex shrink-0 items-center">
        <Button type="button" size="xs" variant="outline" className="rounded-r-none" disabled={focused === undefined && !isWaiting} onClick={onMain}>
          {t('session.sleep')}
        </Button>
        <SessionsMenu agents={agents} focusedRun={focusedRun} isDisabled={all.length === 0 && !isWaiting} onSleep={sleep.one} onSleepAll={sleepAll} />
      </div>
      {pending && <SleepAllConfirm activity={activity} runs={pending} onClose={() => setPending(undefined)} />}
      {loss.dialog}
    </>
  );
}
