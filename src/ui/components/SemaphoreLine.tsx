import { toast } from 'sonner';
import { semaphoreWait } from '@/lib/task-state';
import { postJson } from '@/lib/api';
import { useTick } from '@/hooks/use-tick';
import { t } from '@/i18n';
import type { State, Task } from '../../types';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

// m:ss, never below 0:00 (a clock a second behind the server must not show a negative)
function countdown(until: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / MS_PER_SECOND));
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`;
}

// The server's words never reach the user (#805): any refusal, a 409 after the place moved included, reads the same
const runNow = (semaphore: string, ptyId: string): void => {
  postJson(`/api/semaphores/${encodeURIComponent(semaphore)}/run-now`, { ptyId }).catch(() => toast.error(t('semaphore.runNowFailed')));
};

/** The card's line while one of the task's runs stands in a Command Semaphore's line (#805): its place with executar agora, or its turn
 * counting down. The state over /events moves it; once the place leaves, so does the line. */
export function SemaphoreLine({ task, state }: { task: Task; state: State }) {
  const wait = semaphoreWait(task, state);
  useTick(wait?.turnUntil !== undefined);
  if (wait === undefined) return null;
  const { semaphore, ptyId, place, turnUntil } = wait;
  const sem = <b className="font-medium text-foreground">{semaphore}</b>;
  const [before, after] = (turnUntil === undefined ? t('semaphore.place', { sem: '\u0000', n: place }) : t('semaphore.turn', { sem: '\u0000', time: countdown(turnUntil, Date.now()) })).split('\u0000');
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
      <span className="min-w-0 truncate">{before}{sem}{after}</span>
      {turnUntil === undefined && (
        <button type="button" className="ml-auto shrink-0 text-review hover:underline" aria-label={t('semaphore.runNowLabel', { id: task.item.id, sem: semaphore })} onClick={() => runNow(semaphore, ptyId)}>{t('semaphore.runNow')}</button>
      )}
    </div>
  );
}
