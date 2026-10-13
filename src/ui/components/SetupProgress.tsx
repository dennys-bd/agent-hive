import type { ReactNode } from 'react';
import type { TaskSetup } from '../../types';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

interface SetupSubmitProps { label: ReactNode; pending: boolean; setup?: TaskSetup; disabled?: boolean; onSubmit(): void }

/** A dialog's submit that waits on a worktree (#351), the open dialog's and the Start popup's: while its request is pending it is disabled
 * and its own text is the wait, iniciando… and then preparando a worktree… once the task is marked. The setup's log stays in the console's
 * Setup worktree channel (#290: no ver log icon here or on the card). The step's own command stays on the task and in the log, never in the button. */
export function SetupSubmit({ label, pending, setup, disabled, onSubmit }: SetupSubmitProps) {
  const waiting = `${t(setup === undefined ? 'event.starting' : 'start.preparing')}…`;
  return <Button type="button" onClick={onSubmit} disabled={disabled === true || pending}>{pending ? waiting : label}</Button>;
}
