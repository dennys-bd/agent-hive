import { continueSession, wakeTerminal } from '@/components/sleeping-run';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { type Activity, sleepingOf, sleepingSessions } from '@/lib/activities';
import { type CenterLayout, groupsOf, type RunRef, runsOf } from '@/lib/center-layout';

type WakeOps = Pick<CenterOps, 'holdRun' | 'replaceRun' | 'releaseRun'>;
interface Asleep { terminals: ReadonlySet<string>; sessions: ReadonlySet<string> }

// One run of a stored tab (#696): a sleeping terminal wakes in its own id; a sleeping session continues as #672's sleeping tab does, its new
// run taking the tab over. Only an anchor names its session; a pane's comes from the sleeping run it shows
function wakeRun(activity: Activity, tab: RunRef, ptyId: string, asleep: Asleep, ops: WakeOps): void {
  if (asleep.terminals.has(ptyId)) {
    void wakeTerminal(ptyId);
    return;
  }
  const sessionId = sleepingOf(activity, ptyId)?.sessionId ?? (ptyId === tab.ptyId ? tab.sessionId : undefined);
  if (sessionId === undefined || !asleep.sessions.has(sessionId)) return;
  ops.holdRun(ptyId);
  continueSession(activity, sessionId, (opened) => ops.replaceRun(ptyId, opened.ptyId), () => ops.releaseRun(ptyId));
}

/** Picking a sleeping activity (#696) wakes what its stored layout held when it went to sleep: each sleeping terminal a tab or a pane shows,
 * and each sleeping session a tab names. A session or a terminal no tab names sleeps on; an awake activity, or one with no layout, wakes
 * nothing. */
export function wakeLayout(activity: Activity, layout: CenterLayout | undefined, ops: WakeOps): void {
  if (activity.sleeping !== true || layout === undefined) return;
  const asleep: Asleep = {
    terminals: new Set((activity.terminals ?? []).filter((t) => t.asleep).map((t) => t.terminalId)),
    sessions: new Set(sleepingSessions(activity)),
  };
  for (const tab of groupsOf(layout.root).flatMap((group) => group.tabs)) {
    if (tab.kind === 'run') for (const ptyId of runsOf(tab)) wakeRun(activity, tab, ptyId, asleep, ops);
  }
}
