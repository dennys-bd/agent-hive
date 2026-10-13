import { type ReactNode, useState } from 'react';
import { taskLabel } from '../../tasks.js';
import type { ConfirmLoss } from '@/components/close-tab-notice';
import { Confirm } from '@/components/Confirm';
import { t } from '@/i18n';
import type { Activity } from '@/lib/activities';

interface PendingLoss { sleep(): void; ptyId: string }

// The handoff's context: the terminal by its tab's label, then the task it runs for; a local activity's terminal by its label alone, and
// nothing once the run is gone
function lossContext(activity: Activity | undefined, ptyId: string): string | undefined {
  const label = activity?.runs.find((run) => run.ptyId === ptyId)?.label;
  if (activity === undefined || label === undefined) return undefined;
  return activity.kind === 'task' ? `${label} · ${taskLabel(activity.task)}` : label;
}

/** The agent confirm (#696): before a terminal sleeps from its tab, when an agent the shim missed runs in it. dormir sleeps it and loses the
 * conversation; cancelar leaves it running behind its closed tab. `activity` is the one the caller renders beside, which names the terminal
 * (#75). The caller renders `dialog` beside what it closes. */
export function useConfirmLoss(activity: Activity | undefined): { confirm: ConfirmLoss; dialog: ReactNode } {
  const [pending, setPending] = useState<PendingLoss>();
  const context = pending && lossContext(activity, pending.ptyId);
  const dialog = (
    <Confirm
      open={pending !== undefined} onOpenChange={(isOpen) => { if (!isOpen) setPending(undefined); }}
      title={t('confirm.title.sleep')} context={context === undefined ? undefined : <span className="font-mono">{context}</span>}
      message={t('confirm.agentLost')} confirmLabel={t('session.sleep')} onConfirm={() => pending?.sleep()}
    />
  );
  return { confirm: (sleep, ptyId) => setPending({ sleep, ptyId }), dialog };
}
