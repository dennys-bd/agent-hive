import { activityOf, recordWithSession } from '../../activities';
import { canMoveToStage, SESSION_ID_CHARS } from '../../tasks';
import { transitionKey } from '../../transitions';
import type { State, Task, TryRecord } from '../../types';
import { act, continueTaskSession, stageMoves } from '@/components/actions';
import { useOpenRun } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { isExhausted } from '@/lib/task-state';
import { type Exhausted, exhaustedOf, recordsOf } from '@/lib/try-lines';
import { clock, duration } from '@/lib/usage';

// The details panel's tries (#916): while tries are left, a collapsed list under the status block; once they ran out, the exhausted block in its
// place, with its actions and that transition's tries. Times are read on render: each state broadcast refreshes them, no timer of their own.

const MUTED = 'text-muted-foreground';
type OpenSession = (sessionId: string) => void;
const line = (r: TryRecord): string => t('tries.line', { n: r.n, max: r.max, cause: r.cause });
const keyOf = (r: TryRecord): string => `${r.transition}${r.n}${r.at}`;

// A try's session through its open route, under the record that keeps it, else the live activity's (#629): as SessionsList opens one
function useOpenTrySession(task: Task, state: State): OpenSession {
  const openRun = useOpenRun();
  const id = task.item.itemId;
  return (sessionId) => continueTaskSession(task, { activityId: recordWithSession(state, id, sessionId)?.id ?? activityOf(state, id)?.id ?? '', sessionId }, openRun);
}

// One try (handoff, "Esgotou"): n/max ✕ cause and its clock time; its error's first line; the stage and the session it resumed, with ver saída
function TryBox({ record, locale, open }: { record: TryRecord; locale: string; open: OpenSession }) {
  const { sessionId } = record;
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{line(record)}</span>
        <span className={`tabular-nums ${MUTED}`}>{clock(record.at, locale)}</span>
      </div>
      {record.error !== '' && <p className={`truncate font-mono ${MUTED}`}>{record.error}</p>}
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 truncate ${MUTED}`}>{[record.stage, sessionId?.slice(0, SESSION_ID_CHARS)].filter(Boolean).join(' · ')}</span>
        {sessionId !== undefined && (
          <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => open(sessionId)}>{t('running.output')}</Button>
        )}
      </div>
    </li>
  );
}

function TryBoxes({ shown, records, locale, open }: { shown: Exhausted; records: TryRecord[]; locale: string; open: OpenSession }) {
  const heading = t('tries.sectionOf', { trigger: shown.trigger, n: records.length, max: shown.max });
  return (
    <section aria-label={heading} className="flex flex-col gap-1.5 text-xs">
      <h3 className={MUTED}>{heading}</h3>
      <ul className="flex flex-col gap-1.5">{records.map((r) => <TryBox key={keyOf(r)} record={r} locale={locale} open={open} />)}</ul>
    </section>
  );
}

// tentar de novo (only while the transition is still there), mover para… and abrir sessão; the first two refused while canMoveToStage
// refuses, as the routes do
function ExhaustedActions({ task, state, canRetry, sessionId, open }: { task: Task; state: State; canRetry: boolean; sessionId?: string; open: OpenSession }) {
  const isMovable = canMoveToStage(task, state);
  return (
    <div className="flex gap-1.5">
      {canRetry && (
        <Button type="button" size="xs" disabled={!isMovable} onClick={() => void act(`/tasks/${encodeURIComponent(task.item.itemId)}/retry`)}>{t('tries.exhausted.retry')}</Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!isMovable}>
          <Button type="button" size="xs" variant="outline">{t('tries.exhausted.move')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {stageMoves(task, state).map(({ stage, move }) => <DropdownMenuItem key={stage} onSelect={move}>{stage}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      {sessionId !== undefined && <Button type="button" size="xs" variant="outline" onClick={() => open(sessionId)}>{t('tries.exhausted.openSession')}</Button>}
    </div>
  );
}

/** The exhausted block (#916), in place of the status box while isExhausted: destructive, the transition it ran out on in words, its actions and
 * note, then that transition's tries newest first. A transition gone since the halt leaves the title, the gone text and mover para…. */
export function ExhaustedBlock({ task, state, locale }: { task: Task; state: State; locale: string }) {
  const open = useOpenTrySession(task, state);
  const shown = exhaustedOf(state, task);
  const records = shown === undefined ? [] : recordsOf(activityOf(state, task.item.itemId), transitionKey(shown.transition));
  const title = t('tries.exhausted.title');
  const text = shown === undefined ? t('tries.exhausted.gone', { stage: task.stage })
    : t('tries.exhausted.text', { stage: task.stage, trigger: shown.trigger, max: shown.max, destination: shown.destination });
  return (
    <>
      <section aria-label={title} className="flex flex-col gap-2 rounded-lg border border-destructive bg-destructive/12 p-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium text-destructive">{title}</span>
          <span className={`ml-auto ${MUTED}`}>{t('running.stage', { name: task.stage })}</span>
        </div>
        <p className={`text-[12px] leading-[18px] ${MUTED}`}>{text}</p>
        <ExhaustedActions task={task} state={state} canRetry={shown !== undefined} sessionId={records.find((r) => r.sessionId !== undefined)?.sessionId} open={open} />
        {shown !== undefined && <p className={MUTED}>{t('tries.exhausted.note', { destination: shown.destination })}</p>}
      </section>
      {shown !== undefined && records.length > 0 && <TryBoxes shown={shown} records={records} locale={locale} open={open} />}
    </>
  );
}

/** The tries so far while some are left (#916): closed, since the task is already working again; one line per try, newest first. */
export function TriesSection({ task, state }: { task: Task; state: State }) {
  const records = recordsOf(activityOf(state, task.item.itemId));
  if (records.length === 0 || isExhausted(task, state)) return null;
  const now = Date.now();
  return (
    <details className="text-xs">
      <summary className={`cursor-pointer ${MUTED}`}>{t('tries.section')}</summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {records.map((r) => <li key={keyOf(r)}>{`${line(r)} · ${t('detail.ago', { time: duration(Math.max(0, now - Date.parse(r.at))) })}`}</li>)}
      </ul>
    </details>
  );
}
