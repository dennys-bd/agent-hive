import { localActivityId } from '../../activities';
import type { LaunchPick, OpenResult, Session, Worker } from '../../types';
import { act } from '@/components/actions';
import { shownSize } from '@/lib/xterm-setup';
import type { NewRunKind } from '@/components/NewRunButton';
import { type OpenRun, localRunTab } from '@/components/terminal-tabs';

interface LocalRunOptions { onRun?(ptyId: string): void; onNoRun?(): void; launch?: LaunchPick } // launch: the new session dialog's picks (#257)

const localBase = (workspace: string): string => `/activities/${encodeURIComponent(localActivityId(workspace))}`;

// One local open (#590): posts the route, then hands the answered run to the run opener as the workspace's
function post(route: string, body: Record<string, unknown>, workspace: string, tab: 'terminal' | 'session', open: OpenRun | undefined, { onRun, onNoRun }: LocalRunOptions): void {
  void act<OpenResult>(route, { ...body, size: shownSize() }).then((result) => {
    if (!result?.ptyId) return void onNoRun?.();
    open?.(localRunTab(result.ptyId, workspace, tab));
    onRun?.(result.ptyId);
  });
}

/** A terminal (#292) or an agent's new session (#590) in the workspace's local activity; the session's kind names its agent (#925), and the
 * new session dialog's picks ride with it (#257). A refusal is act's toast; a spawn failure answers no run and opens nothing (#292). onRun
 * hears the run once it is opened (#536). */
export function openLocalRun(workspace: string, kind: NewRunKind, open?: OpenRun, options: LocalRunOptions = {}): void {
  if (kind === 'terminal') post(`${localBase(workspace)}/shell`, {}, workspace, 'terminal', open, options);
  else post(`${localBase(workspace)}/sessions`, { kind, ...options.launch }, workspace, 'session', open, options);
}

/** A local session (#587) continued in a new run: the route reads the session, so it runs that session's own agent (#925); no kind is sent. */
export function continueLocalRun(workspace: string, sessionId: string, open?: OpenRun, options: LocalRunOptions = {}): void {
  post(`${localBase(workspace)}/sessions/${encodeURIComponent(sessionId)}/open`, {}, workspace, 'session', open, options);
}

/** A local session's sidebar line and its row on the activity's home (#587, #759): its live run's tab, a captured one's terminal (#696), else
 * the session continued in a new run. One function, so both act alike. */
export function openLocalSession(workspace: string, session: Pick<Session, 'id'>, worker: Pick<Worker, 'runId' | 'terminalId'> | undefined, openRun?: OpenRun): void {
  const target = worker?.terminalId ?? worker?.runId;
  if (target !== undefined) openRun?.(localRunTab(target, workspace, worker?.terminalId === undefined ? 'session' : 'terminal'));
  else continueLocalRun(workspace, session.id, openRun);
}
