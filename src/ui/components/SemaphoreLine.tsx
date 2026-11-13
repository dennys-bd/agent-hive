import { toast } from 'sonner';
import { semaphoreWait } from '@/lib/task-state';
import { postJson } from '@/lib/api';
import { useTick } from '@/hooks/use-tick';
import { t } from '@/i18n';
import type { State, Task } from '../../types';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const NOT_IN_LINE = 'not_in_line'; // the run-now route's refusal code (NOT_IN_LINE_CODE, src/server-semaphores.ts)

// m:ss, never below 0:00 (a clock a second behind the server must not show a negative)
function countdown(until: string, now: number): string {
  const left = Date.parse(until) - now;
  const seconds = Number.isFinite(left) ? Math.max(0, Math.ceil(left / MS_PER_SECOND)) : 0;
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`;
}

// The server's words never reach the user (#805). A place already gone (a second click, or the turn came first) is shown by the line
// itself, which /events moves, so it gets no toast; any other failure does
const runNow = (semaphore: string, ptyId: string): void => {
  postJson(`/api/semaphores/${encodeURIComponent(semaphore)}/run-now`, { ptyId }).catch((err: unknown) => {
    if ((err as { code?: unknown } | null)?.code !== NOT_IN_LINE) toast.error(t('semaphore.runNowFailed'));
  });
};

/** The card's line while one of the task's runs stands in a Command Semaphore's line (#805): its place with executar agora, or its turn
 * counting down. The state over /events moves it; once the place leaves, so does the line. */
export function SemaphoreLine({ task, state }: { task: Task; state: State }) {
  const wait = semaphoreWait(task, state);
  useTick(wait?.turnUntil !== undefined);
  if (wait === undefined) return null;
  const { semaphore, ptyId, place, turnUntil } = wait;
  // a split on a placeholder puts the name in bold wherever each language places {sem}, which every copy holds once
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
