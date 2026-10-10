import { type ReactElement, useRef } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { t } from '@/i18n';

interface ConfirmProps { message: string; trigger?: ReactElement; open?: boolean; onOpenChange?(open: boolean): void; onConfirm(): void; confirmLabel: string; focusConfirm?: boolean }

/** The plain confirmation (a close, the removal of a worktree, a Stop): the message is the dictionary text, the action runs on confirm only.
 * With a trigger it opens itself; without one the caller drives `open` (#283: Stop picks its run in a menu first). focusConfirm (#818): Enter
 * confirms, the focus on the action instead of Radix's cancel; the files tree's delete, whose key the user already pressed on purpose. */
export function Confirm({ message, trigger, open, onOpenChange, onConfirm, confirmLabel, focusConfirm = false }: ConfirmProps) {
  const action = useRef<HTMLButtonElement>(null);
  const onOpenAutoFocus = (event: Event): void => {
    event.preventDefault();
    action.current?.focus();
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent onOpenAutoFocus={focusConfirm ? onOpenAutoFocus : undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmLabel}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap">{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
          <AlertDialogAction ref={action} onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
