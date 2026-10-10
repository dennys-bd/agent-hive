import { taskLabel } from '../../tasks';
import type { State } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';

const dismiss = (): void => void act('/crash/dismiss');

/** The report of a crash (#283): open while state.crash exists, one line per task a crash stopped that is still in the Hive, each selecting
 * it. Closing it asks the server to drop the report, which the next state closes. */
export function CrashDialog({ state, onSelect }: { state: State; onSelect(taskId: string): void }) {
  if (!state.crash) return null;
  const tasks = state.crash.tasks.flatMap((id) => state.tasks.filter((c) => c.item.itemId === id));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t('crash.lead')}</DialogTitle></DialogHeader>
        <ul aria-label={t('crash.lead')} className="flex flex-col gap-1">
          {tasks.map((c) => (
            <li key={c.item.itemId}>
              <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect(c.item.itemId)}>{taskLabel(c)}</Button>
            </li>
          ))}
        </ul>
        <DialogFooter><Button type="button" onClick={dismiss}>{t('crash.close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
