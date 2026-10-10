import { ScrollTextIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { SETUP_CHANNEL } from '../../console';
import type { TaskSetup } from '../../types';
import { Button } from '@/components/ui/button';
import { useOpenConsole } from '@/hooks/use-console';
import { t } from '@/i18n';

/** The way from a running worktree setup to its log (#351): the console opens on the one setup channel, on the task's run. Nothing
 * outside a Dashboard, where the console lives. `onOpen` lets a modal get out of the console's way. */
export function SetupLogsButton({ consoleId, onOpen }: { consoleId: string; onOpen?(): void }) {
  const openConsole = useOpenConsole();
  if (!openConsole) return null;
  const open = (): void => {
    openConsole(SETUP_CHANNEL.id, consoleId, true); // asked for: the drawer opens (redesign 05)
    onOpen?.();
  };
  return (
    <Button type="button" size="icon-xs" variant="ghost" aria-label={t('task.setupLogs')} title={t('task.setupLogs')} onClick={open}>
      <ScrollTextIcon />
    </Button>
  );
}

interface SetupSubmitProps { label: ReactNode; pending: boolean; setup?: TaskSetup; disabled?: boolean; onSubmit(): void; onOpenLog?(): void }

/** A dialog's submit that waits on a worktree (#351), the open dialog's and the Start popup's: while its request is pending it is disabled
 * and its own text is the wait, iniciando… and then preparando a worktree… once the task is marked, with ver log beside it: its run opens
 * with the mark, before the worktree's git (#351). The step's own command stays on the task and in the log, never in the button. */
export function SetupSubmit({ label, pending, setup, disabled, onSubmit, onOpenLog }: SetupSubmitProps) {
  const waiting = `${t(setup === undefined ? 'event.starting' : 'start.preparing')}…`;
  return (
    <>
      {pending && setup !== undefined && <SetupLogsButton consoleId={setup.consoleId} onOpen={onOpenLog} />}
      <Button type="button" onClick={onSubmit} disabled={disabled === true || pending}>{pending ? waiting : label}</Button>
    </>
  );
}
