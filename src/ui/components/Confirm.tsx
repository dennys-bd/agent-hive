import type { ReactElement, ReactNode } from 'react';
import { type DialogAction, DialogBase } from '@/components/DialogBase';
import { AlertDialogDescription } from '@/components/ui/alert-dialog';

interface ConfirmProps {
  title: string; context?: ReactNode; message: ReactNode; confirmLabel: string; onConfirm(): void | Promise<void>;
  secondary?: DialogAction; error?: string; danger?: boolean; disabled?: boolean; trigger?: ReactElement; open?: boolean; onOpenChange?(open: boolean): void;
}

/** The plain confirmation (#75 on DialogBase): a title of its own, the message as the body, the action as the primary. With a trigger it
 * opens itself; without one the caller drives `open` (#283: Stop picks its run in a menu first). `disabled` (#465): a primary that waits for a valid field. */
export function Confirm({ title, context, message, confirmLabel, onConfirm, secondary, error, danger, disabled, trigger, open, onOpenChange }: ConfirmProps) {
  return (
    <DialogBase
      title={title} context={context} primary={{ label: confirmLabel, onConfirm, danger, disabled }} secondary={secondary} error={error}
      trigger={trigger} open={open} onOpenChange={onOpenChange}
    >
      <AlertDialogDescription className="text-[13px] leading-[19px] text-pretty whitespace-pre-wrap">{message}</AlertDialogDescription>
    </DialogBase>
  );
}
