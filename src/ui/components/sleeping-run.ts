// A sleeping run's continue (#672): its session in a new run, through the paths a sleeping line already uses, and the new run taking over its tab.
import type { OpenResult } from '../../types';
import { toast } from 'sonner';
import { continueTaskSession } from '@/components/actions';
import { openLocalRun } from '@/components/local-runs';
import { RUN_AGENT } from '@/components/NewRunButton';
import type { OpenRun } from '@/components/terminal-tabs';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { type Activity, sleepingOf } from '@/lib/activities';
import { postJson } from '@/lib/api';
import { keptRef } from '@/lib/copy-targets';
import { shownSize } from '@/lib/xterm-setup';

/** Continues `sessionId` of the activity in a new run (#614, #672), as its sleeping line does: the task's open route, or a local session's
 * continue; `open` hears the new run, `onNoRun` a refusal. */
export function continueSession(activity: Activity, sessionId: string, open?: OpenRun, onNoRun?: () => void): void {
  if (activity.kind === 'local') openLocalRun(activity.workspace, RUN_AGENT, open, { continueId: sessionId, onNoRun });
  else continueTaskSession(activity.task, keptRef(activity, sessionId), open, onNoRun);
}

/** A sleeping tab's click (#672): its session continues, and the new run takes over the same tab. The tab is held meanwhile, since the
 * broadcast that drops the sleeping run can arrive before the route's answer; a refused continue lets it go. A sleeping terminal wakes in its
 * own id (#696), so its tab needs no hand-over. */
export function continueSleeping(activity: Activity, ptyId: string, ops: Pick<CenterOps, 'holdRun' | 'replaceRun' | 'releaseRun'>): void {
  const sleeping = sleepingOf(activity, ptyId);
  if (sleeping === undefined) return;
  const { sessionId } = sleeping;
  if (sessionId === undefined) {
    void wakeTerminal(ptyId);
    return;
  }
  ops.holdRun(ptyId);
  continueSession(activity, sessionId, (tab) => ops.replaceRun(ptyId, tab.ptyId), () => ops.releaseRun(ptyId));
}

/** The session a run holds (#614, #672): a sleeping run's own; a live one's from its activity's session lines, a local one's from the workspace's
 * kept sessions. Undefined while its session is not kept yet: there is nothing to continue. */
export function heldSession(activity: Activity, ptyId: string): string | undefined {
  const sleeping = sleepingOf(activity, ptyId);
  if (sleeping !== undefined) return sleeping.sessionId;
  if (activity.kind === 'local') return activity.kept.find((k) => k.run?.ptyId === ptyId)?.session.id;
  return activity.sessions.find((s) => s.run?.ptyId === ptyId)?.session?.id;
}

const HTTP_CONFLICT = 409;

/** A sleeping terminal wakes in its own id (#696): its line, its tab and its activity's pick all go through here. A 409 is a wake that lost a
 * harmless race (a double click, a repeated pick: already awake, or its old pty still ending): no toast. Any other refusal shows its reason. */
export const wakeTerminal = (terminalId: string): Promise<OpenResult | undefined> =>
  postJson<OpenResult>(`/terminals/${encodeURIComponent(terminalId)}/wake`, { size: shownSize() }).catch((err: Error & { status?: number }) => {
    if (err.status !== HTTP_CONFLICT) toast.error(err.message);
    return undefined;
  });
