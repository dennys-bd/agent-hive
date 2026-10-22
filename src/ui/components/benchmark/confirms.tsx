import type { Experiment } from '../../../types';
import { Confirm } from '@/components/Confirm';
import { t } from '@/i18n';

interface ConfirmArgs { experiment?: Experiment; open: boolean; onOpenChange(open: boolean): void; onConfirm(): Promise<void> }

/** dlg-dup (#461): the context is the experiment's name; confirming posts kind duplicate. Shared by the sidebar's submenu and the header. */
export function DuplicateConfirm({ experiment, open, onOpenChange, onConfirm }: ConfirmArgs) {
  if (experiment === undefined) return null;
  return (
    <Confirm
      title={t('benchmark.header.duplicateTitle')} context={<span className="font-mono">{experiment.name}</span>} message={t('benchmark.header.duplicateText')}
      confirmLabel={t('benchmark.header.duplicate')} onConfirm={onConfirm} open={open} onOpenChange={onOpenChange}
    />
  );
}
