import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';
import type { LiveRun } from '../../task-runs';
import type { State, Task } from '../../types';
import { whereOf } from '@/components/close-tab-notice';
import { ButtonKeyHint } from '@/components/KeyHint';
import { CONTEXT_KIT, type MenuKit } from '@/components/menu-kit';
import { ranAgent } from '../../agents';
import { agentName } from '@/components/NewRunButton';
import { useSleep, waitsForCi } from '@/components/sleep-notice';
import { StatusWord } from '@/components/StatusWord';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { type Activity, runStatus, taskActivity } from '@/lib/activities';
import { pressed } from '@/lib/shortcut-bindings';
import { strayAgents } from '@/lib/stray-agents';

interface SleepAllConfirmProps { activity: Activity; runs: LiveRun[]; onClose(): void }

/** Whether dormir todas asks first (#672, #696): on several runs, and on any terminal, whose stray agents its dialog checks. */
export const asksBeforeSleepAll = (runs: readonly LiveRun[]): boolean => runs.length > 1 || runs.some((run) => run.kind === 'terminal');

// How many agents the shim missed run in these terminals (#696), read once the dialog opens; 0 until the answers come
function useStrayAgents(terminals: readonly string[]): number {
  const [count, setCount] = useState(0);
  const key = terminals.join('\n');
  useEffect(() => {
    let isLive = true;
    const ids = key === '' ? [] : key.split('\n');
    void Promise.all(ids.map(strayAgents)).then((counts) => { if (isLive) setCount(counts.reduce((sum, n) => sum + n, 0)); });
    return () => { isLive = false; };
  }, [key]);
  return count;
}

// One row (#672): an agent session with its short id in mono and its status in its status colour; a terminal by its label (#696)
function RunRow({ activity, run }: { activity: Activity; run: LiveRun }) {
  if (run.kind === 'terminal') return <li className="flex items-center gap-2"><span className="shrink-0">{run.label}</span></li>;
  return (
    <li className="flex items-center gap-2">
      <span className="shrink-0">{agentName(ranAgent(run))}</span>
      <span className="min-w-0 truncate font-mono text-muted-foreground">{run.session ?? ''}</span>
      <span className="ml-auto"><StatusWord status={runStatus(activity, run.ptyId) ?? 'empty'} emptyWord="session.sleeping" /></span>
    </li>
  );
}

/** dormir todas' dialog (#672): the activity, what sleeping does, then one row per session and per terminal (#696), and the lost-conversation
 * line when an agent the shim missed runs in one of the terminals; cancelar, and dormir todas with the confirm key, which posts one sleep for
 * all of them. The caller puts it beside its menu, never inside: a menu item's onSelect closes the menu and would unmount it. */
export function SleepAllConfirm({ activity, runs, onClose }: SleepAllConfirmProps) {
  const sleep = useSleep(activity);
  const lost = useStrayAgents(runs.filter((run) => run.kind === 'terminal').map((run) => run.ptyId));
  const go = (): void => {
    sleep.all(runs);
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (pressed(e.nativeEvent, 'confirm')) { e.preventDefault(); go(); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]" onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>{t('sleepAll.title', { where: whereOf(activity) })}</DialogTitle>
          <DialogDescription>{t('sleepAll.subtitle')}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1.5 text-sm">{runs.map((run) => <RunRow key={run.ptyId} activity={activity} run={run} />)}</ul>
        {lost > 0 && <p className="text-sm">{t('confirm.agentLost')}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('base.cancel')}</Button>
          <Button type="button" onClick={go}>{t('sleep.all')}<ButtonKeyHint id="confirm" /></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SleepMenu { items: ReactNode; dialog: ReactNode }

/** Right-click › dormir (#343, #672) of an activity, a task's or a local one's (#696): nothing with no live run; one agent session alone, a
 * plain item that sleeps it at once; terminals alone, dormir todas; else a submenu listing each session (labelled like RunPicker) plus dormir
 * todas, which confirms in its dialog and sleeps the terminals too. Never in the destructive colour: sleeping loses nothing. A run command is
 * not listed: its own item stops it (#353). A wait for CI (#834) is a run of the stage with no pty: alone, the plain item ends it; beside runs,
 * dormir todas ends it with them. */
export function useActivitySleepMenu(activity: Activity | undefined, { kit = CONTEXT_KIT }: { kit?: MenuKit } = {}): SleepMenu {
  const sleep = useSleep(activity);
  const [pending, setPending] = useState<LiveRun[]>();
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;
  const all = activity?.runs ?? [];
  const agents = all.filter((run) => run.kind !== 'terminal');
  const sleepAll = <Item onSelect={() => setPending(all)}>{t('sleep.all')}</Item>;
  const isWaiting = waitsForCi(activity); // #834
  let items: ReactNode = null;
  if (all.length === 0 && isWaiting) items = <Item onSelect={sleep.ci}>{t('session.sleep')}</Item>;
  else if (!isWaiting && all.length === 1 && agents.length === 1) items = <Item onSelect={() => sleep.one(agents[0])}>{t('session.sleep')}</Item>;
  else if (all.length > 0 && agents.length === 0) items = sleepAll;
  else if (all.length > 0) {
    items = (
      <Sub>
        <SubTrigger>{t('session.sleep')}</SubTrigger>
        <SubContent>
          {agents.map((run) => <Item key={run.ptyId} onSelect={() => sleep.one(run)}>{run.label}</Item>)}
          <Separator />
          {sleepAll}
        </SubContent>
      </Sub>
    );
  }
  const dialog = pending && activity && <SleepAllConfirm activity={activity} runs={pending} onClose={() => setPending(undefined)} />;
  return { items, dialog };
}

/** The task's own menu and the activity's (#343, #536): useActivitySleepMenu on the task's activity. */
export const useSleepMenu = (task: Task, state: State, options: { kit?: MenuKit } = {}): SleepMenu => useActivitySleepMenu(taskActivity(state, task), options);
