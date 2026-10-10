import { type ReactNode, useState } from 'react';
import type { ConfirmLoss } from '@/components/close-tab-notice';
import { Confirm } from '@/components/Confirm';
import { t } from '@/i18n';

/** The agent confirm (#696): before a terminal sleeps from its tab, when an agent the shim missed runs in it. dormir sleeps it and loses the
 * conversation; cancelar leaves it running behind its closed tab. The caller renders `dialog` beside what it closes. */
export function useConfirmLoss(): { confirm: ConfirmLoss; dialog: ReactNode } {
  const [pending, setPending] = useState<() => void>();
  const dialog = (
    <Confirm
      open={pending !== undefined} onOpenChange={(isOpen) => { if (!isOpen) setPending(undefined); }}
      message={t('confirm.agentLost')} confirmLabel={t('session.sleep')} onConfirm={() => pending?.()}
    />
  );
  return { confirm: (sleep) => setPending(() => sleep), dialog };
}
