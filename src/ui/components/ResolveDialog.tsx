import { useContext, useState } from 'react';
import { activityOf, workersIn } from '../../activities';
import { type LiveRun, liveRuns } from '../../task-runs';
import { worktreeSessions } from '../../tasks';
import { type AgentId, NEW_SESSION, type OpenResult, type State, type Task } from '../../types';
import { attachRun, focusRun } from '@/components/actions';
import { DialogBase } from '@/components/DialogBase';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { SessionLabel } from '@/components/SessionLabel';
import { type OpenRun, runTab, useOpenRun } from '@/components/terminal-tabs';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { shownSize } from '@/lib/xterm-setup';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

/** Where the merge-from-base prompt may go (#379): a session a live run holds (`run` set), a stopped one to resume, or a new session. */
export interface ResolveTarget { id: string; agent: AgentId; run?: LiveRun }

/** The resolve dialog's list (#379): the sessions live runs of the task hold, then the stopped ones that resume in its worktree newest first,
 * then a new session of the default agent. worktreeSessions leaves the held ones out, so the live ones come from the activity's workers. */
export function resolveTargets(task: Task, state: State, agent: AgentId): ResolveTarget[] {
  const runs = liveRuns(task, state);
  const live = workersIn(state.workers, activityOf(state, task.item.itemId)?.id).flatMap((w): ResolveTarget[] => {
    const run = runs.find((r) => r.ptyId === w.runId);
    return w.sessionId === undefined || run === undefined ? [] : [{ id: w.sessionId, agent: run.agent ?? agent, run }];
  });
  const stopped = worktreeSessions(task, state).map((s): ResolveTarget => ({ id: s.id, agent: s.agent })).reverse();
  return [...live, ...stopped, { id: NEW_SESSION, agent }];
}

const taskPath = (task: Task, route: string): string => `/tasks/${encodeURIComponent(task.item.itemId)}/${route}`;

// The prompt to the picked target (#379): a live session's run focused and the prompt pasted through /resolve; a stopped one resumed and a
// new one opened through /open, its run attached as resolve's new session always was (#758)
async function sendTo(task: Task, target: ResolveTarget, base: string, openRun: OpenRun | undefined): Promise<void> {
  if (target.run !== undefined) {
    await postJson(taskPath(task, 'resolve'), { to: target.id, promptBase: base });
    focusRun(runTab(task, target.run), openRun); // after the paste: a refused one keeps the user on the dialog
    return;
  }
  const resume = target.id === NEW_SESSION ? {} : { continueId: target.id };
  const result = await postJson<OpenResult>(taskPath(task, 'open'), { kind: target.agent, ...resume, prompt: 'mergeBase', promptBase: base, size: shownSize() });
  attachRun(result, task, 'session', openRun);
}

const statusOf = (err: unknown): unknown => (err instanceof Error && 'status' in err ? err.status : undefined);

// A refusal in the dialog's words (#379): a live session that turned busy or ended since the list was drawn (the route's 409 or 400) says so,
// so the user picks another; anything else is unexpected
function failureText(err: unknown, target: ResolveTarget): string {
  const status = statusOf(err);
  const isGone = target.run !== undefined && (status === HTTP_BAD_REQUEST || status === HTTP_CONFLICT);
  return isGone ? t('pr.resolve.busy') : t('pr.resolve.failed');
}

export interface ResolveDialogProps { task: Task; base: string; state: State; onClose(): void }

/** resolve in the activity's dialog (#379): the task's sessions, a live one marked, then a new session; the primary sends the merge-from-base
 * prompt to the one picked. A failure stays in the dialog as its error, the raw reason in the log. */
export function ResolveDialog({ task, base, state, onClose }: ResolveDialogProps) {
  const openRun = useOpenRun();
  const agent = useContext(DefaultAgentContext);
  const targets = resolveTargets(task, state, agent);
  const [picked, setPicked] = useState(targets[0]?.id ?? NEW_SESSION);
  const [error, setError] = useState<string>();
  const target = targets.find((x) => x.id === picked) ?? { id: NEW_SESSION, agent };
  const title = t('pr.resolve.title', { base });
  const confirm = (): Promise<void> => {
    setError(undefined);
    return sendTo(task, target, base, openRun).catch((err: unknown) => {
      console.error(`resolve: the merge prompt did not reach ${target.id}`, err);
      setError(failureText(err, target));
      throw err; // DialogBase keeps the dialog open on a rejection
    });
  };
  return (
    <DialogBase open onOpenChange={(open) => { if (!open) onClose(); }} title={title} primary={{ label: t('pr.resolve.send'), onConfirm: confirm }} error={error}>
      <fieldset aria-label={title} className="flex flex-col gap-1.5">
        {targets.map((x) => (
          <label key={x.id} className="flex items-center gap-2 text-[13px]">
            <input type="radio" name="resolve-target" value={x.id} checked={x.id === picked} onChange={() => setPicked(x.id)} />
            <SessionLabel id={x.id} agent={x.agent} />
            {x.run !== undefined && <span className="text-xs text-muted-foreground"><span aria-hidden="true" className="text-working">●</span> {t('pr.resolve.live')}</span>}
          </label>
        ))}
      </fieldset>
    </DialogBase>
  );
}
