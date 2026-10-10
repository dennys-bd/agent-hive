import { localActivityId } from '../../activities';
import type { OpenResult, Session, Worker } from '../../types';
import { act } from '@/components/actions';
import { shownSize } from '@/lib/xterm-setup';
import { type NewRunKind, RUN_AGENT } from '@/components/NewRunButton';
import { type OpenRun, localRunTab } from '@/components/terminal-tabs';

interface LocalRunOptions { continueId?: string; onRun?(ptyId: string): void; onNoRun?(): void }

// The route of each run the local activity opens (#629): a terminal on the checkout (#292), a local session continued (#587) or a new one (#590)
function localRoute(workspace: string, kind: NewRunKind, continueId?: string): string {
  const base = `/activities/${encodeURIComponent(localActivityId(workspace))}`;
  if (kind === 'terminal') return `${base}/shell`;
  return continueId === undefined ? `${base}/sessions` : `${base}/sessions/${encodeURIComponent(continueId)}/open`;
}

/** A terminal or an agent's session in the workspace's local activity (#590), `continueId` continuing a local session (#587); the run it answered
 * goes to the run opener as the workspace's, which shows it in the local activity. A refusal is act's toast; a spawn failure answers no run
 * and opens nothing (#292). onRun hears the run once it is opened, so the split menu can land its tab (#536). */
export function openLocalRun(workspace: string, kind: NewRunKind, open?: OpenRun, { continueId, onRun, onNoRun }: LocalRunOptions = {}): void {
  void act<OpenResult>(localRoute(workspace, kind, continueId), { size: shownSize() }).then((result) => {
    if (!result?.ptyId) return void onNoRun?.();
    open?.(localRunTab(result.ptyId, workspace, kind === 'terminal' ? 'terminal' : 'session'));
    onRun?.(result.ptyId);
  });
}

/** A local session's sidebar line and its row on the activity's home (#587, #759): its live run's tab, a captured one's terminal (#696), else
 * the session continued in a new run. One function, so both act alike. RUN_AGENT is read at call time, so the import cycle with
 * NewRunButton is harmless. */
export function openLocalSession(workspace: string, session: Pick<Session, 'id'>, worker: Pick<Worker, 'runId' | 'terminalId'> | undefined, openRun?: OpenRun): void {
  const target = worker?.terminalId ?? worker?.runId;
  if (target !== undefined) openRun?.(localRunTab(target, workspace, worker?.terminalId === undefined ? 'session' : 'terminal'));
  else openLocalRun(workspace, RUN_AGENT, openRun, { continueId: session.id });
}
