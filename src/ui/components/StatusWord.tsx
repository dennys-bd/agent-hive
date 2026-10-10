import { type MessageKey, statusText, t } from '@/i18n';
import { STATUS_DOT, STATUS_TEXT, type TaskState } from '@/lib/status';

/** A status as a 6px dot and its word in the status colour (redesign 08): the home's rows and the activities sidebar's sessions (redesign 03).
 * `empty` reads `emptyWord`: parada by default, dormindo on a session line, which no run holds (#614). */
export function StatusWord({ status, emptyWord = 'detail.stopped' }: { status: TaskState; emptyWord?: MessageKey }) {
  return (
    <span className={`flex shrink-0 items-center gap-[5px] whitespace-nowrap text-xs ${STATUS_TEXT[status]}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {status === 'empty' ? t(emptyWord) : statusText(status)}
    </span>
  );
}
