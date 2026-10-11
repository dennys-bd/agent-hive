import { useEffect, useState } from 'react';
import { taskLabel } from '../../tasks';
import type { Checkpoint, Task } from '../../types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { getJson, postJson } from '@/lib/api';

/** GET /activities/:id/checkpoints/:n/restore (#619): Restart's plan for the checkpoint's head. */
interface RestorePreview { mode: 'reset' | 'branch'; branch: string; newBranch?: string }
interface RestoreDialogProps { task: Task; activityId: string; checkpoint: Checkpoint; onClose(): void }

/** A restore's confirmation (#619), in Restart's layout: the lead, the published-branch sentence in branch mode, and that the current state is kept
 * as a checkpoint; no discards row, since nothing is discarded. A failure stays in here as the dialog's own message, git's words go to hive.log. */
export function RestoreDialog({ task, activityId, checkpoint, onClose }: RestoreDialogProps) {
  const [preview, setPreview] = useState<RestorePreview>();
  const [failed, setFailed] = useState(false);
  const path = `/activities/${encodeURIComponent(activityId)}/checkpoints/${checkpoint.n}/restore`;
  useEffect(() => { getJson<RestorePreview>(path).then(setPreview, () => setFailed(true)); }, [path]);
  const confirm = (): void => { postJson(path, {}).then(onClose, () => setFailed(true)); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('restore.title', { n: checkpoint.n, stage: checkpoint.stage })}</DialogTitle>
          <DialogDescription>{taskLabel(task)}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">{t('restore.lead')}</p>
        {preview?.mode === 'branch' && <p className="text-sm">{t('restart.branch', { branch: preview.branch, newBranch: preview.newBranch ?? '' })}</p>}
        <p className="text-muted-foreground text-sm">{t('restore.kept')}</p>
        {failed && <p role="alert" className="text-destructive text-sm">{t('restore.error')}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('base.cancel')}</Button>
          <Button type="button" onClick={confirm} disabled={preview === undefined}>{t('restore.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
