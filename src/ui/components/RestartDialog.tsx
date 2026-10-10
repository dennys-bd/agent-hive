import { useEffect, useState } from 'react';
import { taskLabel } from '../../tasks';
import { activityOf } from '../../activities';
import type { State, Task } from '../../types';
import { discardText, keptStages, keptText, type RestartWork, returnTo } from '@/components/restart-preview';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { getJson, postJson } from '@/lib/api';
import { shownSize } from '@/lib/xterm-setup';

/** GET /activities/:id/restart (#283, #580): the plan, and what the git there counted. */
interface RestartPreview { mode: 'reset' | 'branch'; branch: string; newBranch?: string; commits: number; files: number }

const MUTED = 'text-muted-foreground';

// What descarta reads before the preview answers (#580): a pulsing bar while it loads, so the box keeps its height; a dash once it failed
function Discards({ task, state, preview, failed }: { task: Task; state: RestartWork; preview?: RestartPreview; failed: boolean }) {
  if (preview) return <>{discardText(task, state, preview)}</>;
  return failed ? <>—</> : <span aria-hidden className="block h-3 w-3/4 animate-pulse rounded bg-muted" />;
}

// The mockup's box (#580): descarta, volta para, and mantém only while another stage ran on the task. Shown at once: only descarta needs
// the server, the other rows come from the task
function PreviewBox({ task, state, preview, failed }: { task: Task; state: RestartState; preview?: RestartPreview; failed: boolean }) {
  const back = returnTo(task, state);
  const kept = keptStages(task, state, state.stages);
  return (
    <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-1.5 rounded-md border p-2.5 text-xs">
      <dt className={MUTED}>{t('restart.discards')}</dt>
      <dd aria-busy={preview === undefined && !failed}><Discards task={task} state={state} preview={preview} failed={failed} /></dd>
      {back && (
        <>
          <dt className={MUTED}>{t('restart.returnsTo')}</dt>
          <dd><span className="font-mono">{back.sha}</span>{` · ${back.label}`}</dd>
        </>
      )}
      {kept.length > 0 && (
        <>
          <dt className={MUTED}>{t('restart.keeps')}</dt>
          <dd>{keptText(kept)}</dd>
        </>
      )}
    </dl>
  );
}

/** What the dialog reads besides the task (#629): the stages for mantém, its activity and records for the rest. */
export type RestartState = RestartWork & Pick<State, 'stages'>;
interface RestartDialogProps { task: Task; state: RestartState; onStarted?(): void; onClose(): void }

/** Restart's confirmation (#283, #580): what the restart discards, where the worktree goes back to and what it keeps, from the server's preview
 * and the task; a published branch's sentence under the box. Then the POST that runs the git and the new session. A refusal stays in here
 * with git's words. */
export function RestartDialog({ task, state, onStarted, onClose }: RestartDialogProps) {
  const [preview, setPreview] = useState<RestartPreview>();
  const [error, setError] = useState<string>();
  const path = `/activities/${encodeURIComponent(activityOf(state, task.item.itemId)?.id ?? '')}/restart`; // the live activity's worktree (#629)
  useEffect(() => { getJson<RestartPreview>(path).then(setPreview, (err: Error) => setError(err.message)); }, [path]);
  const confirm = (): void => {
    postJson(path, { size: shownSize() }).then(() => { onStarted?.(); onClose(); }, (err: Error) => setError(err.message)); // onStarted: the new session's center (#457)
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('restart.title', { stage: task.stage })}</DialogTitle>
          <DialogDescription>{taskLabel(task)}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">{t('restart.lead')}</p>
        <PreviewBox task={task} state={state} preview={preview} failed={error !== undefined} />
        {preview?.mode === 'branch' && <p className="text-sm">{t('restart.branch', { branch: preview.branch, newBranch: preview.newBranch ?? '' })}</p>}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('base.cancel')}</Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={preview === undefined}>{t('restart.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
