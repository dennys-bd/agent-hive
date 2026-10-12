// A sleeping run's continue (#672): its session in a new run, through the paths a sleeping line already uses, and the new run taking over its tab.
import type { AgentId, OpenResult } from '../../types';
import { toast } from 'sonner';
import { continueTaskSession } from '@/components/actions';
import { forgetRun } from '@/components/close-tab-notice';
import { continueLocalRun } from '@/components/local-runs';
import { openNew } from '@/components/NewRunButton';
import type { OpenRun } from '@/components/terminal-tabs';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { type Activity, sleepingOf } from '@/lib/activities';
import { postJson } from '@/lib/api';
import { keptRef } from '@/lib/copy-targets';
import { shownSize } from '@/lib/xterm-setup';

/** Continues `sessionId` of the activity in a new run (#614, #672), as its sleeping line does: the task's open route, or a local session's
 * continue; `open` hears the new run, `onNoRun` a refusal. */
export function continueSession(activity: Activity, sessionId: string, open?: OpenRun, onNoRun?: () => void): void {
  if (activity.kind === 'local') continueLocalRun(activity.workspace, sessionId, open, { onNoRun });
  else continueTaskSession(activity.task, keptRef(activity, sessionId), open, onNoRun);
}

/** A sleeping tab's click (#672): its session continues, and the new run takes over the same tab. The tab is held meanwhile, since the
 * broadcast that drops the sleeping run can arrive before the route's answer; a refused continue lets it go. A sleeping terminal wakes in its
 * own id (#696), so its tab needs no hand-over. A session slept before its first prompt (#931, Codex) has nothing to resume: a new session of
 * its agent takes the tab, then the old record goes. */
export function continueSleeping(activity: Activity, ptyId: string, ops: Pick<CenterOps, 'holdRun' | 'replaceRun' | 'releaseRun'>): void {
  const sleeping = sleepingOf(activity, ptyId);
  if (sleeping === undefined) return;
  const { sessionId, run: { agent } } = sleeping;
  if (sessionId === undefined && agent === undefined) {
    void wakeTerminal(ptyId);
    return;
  }
  ops.holdRun(ptyId);
  const take = (tab: { ptyId: string }): void => ops.replaceRun(ptyId, tab.ptyId);
  const release = (): void => ops.releaseRun(ptyId);
  if (sessionId !== undefined) continueSession(activity, sessionId, take, release);
  else if (agent !== undefined) openFresh(activity, agent, ptyId, take, release);
}

// #931: the new session first, so the tab is never left without a run; the old record and its ring go once the new run holds the tab
function openFresh(activity: Activity, agent: AgentId, ptyId: string, take: (tab: { ptyId: string }) => void, release: () => void): void {
  openNew(activity, agent, (tab) => { take(tab); forgetRun(ptyId); }, undefined, release);
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

/** A sleeping terminal wakes in its own id (#696): its line and its tab go through here. A 409 is a wake that lost a
 * harmless race (a double click: already awake, or its old pty still ending): no toast. Any other refusal shows its reason. */
export const wakeTerminal = (terminalId: string): Promise<OpenResult | undefined> =>
  postJson<OpenResult>(`/terminals/${encodeURIComponent(terminalId)}/wake`, { size: shownSize() }).catch((err: Error & { status?: number }) => {
    if (err.status !== HTTP_CONFLICT) toast.error(err.message);
    return undefined;
  });
