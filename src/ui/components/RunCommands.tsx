import { type ReactNode, useState } from 'react';
import { activityOf } from '../../activities';
import { canRunCommand, commandsOf, liveCommand } from '../../task-runs';
import type { Task, State } from '../../types';
import { act, runCommand } from '@/components/actions';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { useOpenConsole } from '@/hooks/use-console';
import { t } from '@/i18n';

/** A run command's Stop (#353): `ask` holds the run until the user answers the same Confirm as Parar, then it stops by its pty id. The
 * dialog sits beside the caller's menu, never inside it: a menu item's onSelect closes the menu and would unmount it (see useSleepMenu). */
export function useCommandStop(): { ask(ptyId: string): void; dialog: ReactNode } {
  const [pending, setPending] = useState<string>();
  const dialog = pending !== undefined && (
    <Confirm
      open
      onOpenChange={(open) => { if (!open) setPending(undefined); }}
      message={t('confirm.close')}
      confirmLabel={t('detail.closeWorker')}
      onConfirm={() => void act(`/ptys/${encodeURIComponent(pending)}/stop`)}
    />
  );
  return { ask: setPending, dialog };
}

/** The panel's run commands (#300): one button per command of the task's workspace; nothing when it has none. A start is disabled until the task
 * has a worktree on disk (the route answers 409 then) and shows the console on the run (#353). While a command is live on the task its button
 * reads Parar <nome> and stops that run, never disabled. The panel's footer asks for `sm`, to match the workers bar (#344). */
export function RunCommands({ task, state, size = 'xs' }: { task: Task; state: State; size?: 'xs' | 'sm' }) {
  const openConsole = useOpenConsole();
  const stop = useCommandStop();
  const runnable = canRunCommand(task, activityOf(state, task.item.itemId));
  return (
    <>
      {commandsOf(task, state).map((name) => {
        const live = liveCommand(task, state, name);
        return live === undefined
          ? <Button key={name} type="button" size={size} variant="outline" disabled={!runnable} onClick={() => runCommand(task, state, name, openConsole)}>{name}</Button>
          : <Button key={name} type="button" size={size} variant="outline" onClick={() => stop.ask(live)}>{t('command.stop', { name })}</Button>;
      })}
      {stop.dialog}
    </>
  );
}
