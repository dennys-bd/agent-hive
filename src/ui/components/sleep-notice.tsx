// The sleep notice (#672): every time a session sleeps, under its cause's switch: a manual sleep, the auto flow's end of a stage run, the idle
// shutdown, a sleep all. The view is SleepNotice.tsx; this mounts it in sonner and builds what it says.
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { LiveRun } from '../../task-runs';
import { ranAgent } from '../../agents';
import type { AgentId, SleepCause } from '../../types';
import { act } from '@/components/actions';
import { type CloseTabSettings, type SleepNoticeKey, stopRun, useCloseTab, whereOf } from '@/components/close-tab-notice';
import { NOTICE_MS, NOTICE_WIDTH } from '@/components/NoticeShell';
import { continueSession, heldSession } from '@/components/sleeping-run';
import { SleepNotice } from '@/components/SleepNotice';
import { type OpenRun, useOpenRun } from '@/components/terminal-tabs';
import type { Activity } from '@/lib/activities';
import { isTabOpen, readCenterLayouts } from '@/lib/center-layout';

/** The switch each cause of a sleep shows its notice under (#672). */
export const SLEEP_NOTICE_KEY: Record<SleepCause, SleepNoticeKey> = { manual: 'sleepNotice', auto: 'sleepAutoNotice', idle: 'sleepIdleNotice', all: 'sleepAllNotice' };

/** One session that slept, as the notice names it: its run, its name or short id, a stage run's stage. */
export interface SleptSession { ptyId: string; agent: AgentId; session?: string; stage?: string }

/** What showSleepNotice shows (#672): why the sessions slept, who, where, and what continues them all. */
export interface SleepNoticeInput { cause: SleepCause; sessions: SleptSession[]; where: string; onContinue?(): void }

/** The notice's words for `runs` of the activity (#672), read while their sessions are still known: continuar continues each session in a new
 * run, as its sleeping line does; none when no run held a kept session yet. */
export function sleepInput(activity: Activity, runs: LiveRun[], cause: SleepCause, openRun?: OpenRun): SleepNoticeInput {
  const stageOf = (run: LiveRun): string | undefined => (run.kind === 'stage' && activity.kind === 'task' ? activity.task.stage : undefined);
  const ids = runs.flatMap((run) => heldSession(activity, run.ptyId) ?? []);
  return {
    cause, where: whereOf(activity),
    sessions: runs.map((run) => ({ ptyId: run.ptyId, agent: ranAgent(run), session: run.session, stage: stageOf(run) })),
    ...(ids.length === 0 ? {} : { onContinue: () => { for (const id of ids) continueSession(activity, id, openRun); } }),
  };
}

/** The sleep notice (#672) while its cause's switch is on, for NOTICE_MS: each action closes it first; its checkbox saves its cause's switch
 * off (or back on) and leaves it open. A single session reads whether its tab is still open in some activity's layout. */
export function showSleepNotice(input: SleepNoticeInput, settings: CloseTabSettings): void {
  const key = SLEEP_NOTICE_KEY[input.cause];
  if (settings[key] === false) return;
  const [first] = input.sessions;
  const hasTab = input.sessions.length === 1 && first !== undefined && isTabOpen(readCenterLayouts(), first.ptyId);
  const { openSettings, saveNotice } = settings;
  toast.custom((id) => {
    const then = (action: () => void) => (): void => {
      toast.dismiss(id);
      action();
    };
    return (
      <SleepNotice
        sessions={input.sessions} where={input.where} hasTab={hasTab}
        onContinue={input.onContinue && then(input.onContinue)} onSettings={openSettings && then(openSettings)}
        onDontWarn={saveNotice && ((checked) => saveNotice(key, !checked))} onClose={() => toast.dismiss(id)}
      />
    );
  }, { duration: NOTICE_MS, style: { width: NOTICE_WIDTH } });
}

/** The sleeps the Hive decides itself (#672), the auto flow's and the idle shutdown's: a sleeping run the activities gain with that cause
 * shows its notice once. The first list is taken as seen, so a reload never shows the old ones again; a manual sleep and a sleep all are
 * shown by the UI that asked. */
export function useSleptNotices(activities: Activity[], openRun?: OpenRun): void {
  const settings = useCloseTab();
  const seen = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    const sleeping = activities.flatMap((activity) => (activity.slept ?? []).map((slept) => ({ activity, slept })));
    const known = seen.current;
    seen.current = new Set(sleeping.map(({ slept }) => slept.run.ptyId));
    if (known === undefined) return;
    for (const { activity, slept } of sleeping) {
      if (known.has(slept.run.ptyId) || (slept.cause !== 'auto' && slept.cause !== 'idle')) continue;
      showSleepNotice(sleepInput(activity, [slept.run], slept.cause, openRun), settings);
    }
  }, [activities, openRun, settings]);
}

/** A wait for CI on the activity (#834): an automatic run of a stage with no pty, which the Stop and the sleeps end through its own route. */
export const waitsForCi = (activity: Activity | undefined): boolean => activity?.kind === 'task' && activity.activity.ci !== undefined;
const stopCi = (activity: Activity): void => void act<{ ok: true }>(`/activities/${encodeURIComponent(activity.activity.id)}/ci/stop`);

/** A manual sleep, a sleep all (#672) and the Stop of a wait for CI (#834). */
export interface Sleep { one(run: LiveRun): void; all(runs: LiveRun[]): void; ci(): void }

/** One session through its stop route, cause manual; a sleep all through POST /ptys/sleep, cause all, and the activity's wait for CI with it
 * (#834). Each shows its notice once the server took it, a sleep all one notice for every session; a wait shows none, no session slept. No
 * activity: nothing to sleep. */
export function useSleep(activity: Activity | undefined): Sleep {
  const settings = useCloseTab();
  const openRun = useOpenRun();
  return {
    one: (run) => {
      if (activity === undefined) return;
      const input = sleepInput(activity, [run], 'manual', openRun);
      void stopRun(run.ptyId).then((isAsleep) => { if (isAsleep) showSleepNotice(input, settings); });
    },
    all: (runs) => {
      if (activity === undefined) return;
      if (waitsForCi(activity)) stopCi(activity); // #834: a sleep all ends the wait too
      if (runs.length === 0) return;
      const sessions = runs.filter((run) => run.kind !== 'terminal'); // #696: the notice speaks of sessions; a terminal's line says it sleeps
      const input = sleepInput(activity, sessions, 'all', openRun);
      void act<{ ok: true }>('/ptys/sleep', { ptyIds: runs.map((run) => run.ptyId) }).then((answer) => { if (answer !== undefined && sessions.length > 0) showSleepNotice(input, settings); });
    },
    ci: () => { if (activity !== undefined && waitsForCi(activity)) stopCi(activity); },
  };
}
