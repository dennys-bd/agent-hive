import { CheckIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { SETUP_CHANNEL } from '../../console';
import type { SetupRow, SetupRows, SetupRowStatus, TaskSetup } from '../../types';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useOpenConsole } from '@/hooks/use-console';
import { isSkipped, useSetupLog } from '@/hooks/use-setup-log';
import { useTick } from '@/hooks/use-tick';
import { t } from '@/i18n';
import { formatDuration } from '@/lib/running-lines';

interface SetupSubmitProps { label: ReactNode; pending: boolean; setup?: TaskSetup; disabled?: boolean; onSubmit(): void }

/** A dialog's submit that waits on a worktree (#351), the open dialog's and the Start popup's: while its request is pending it is disabled
 * and its own text is the wait, iniciando… and then preparando a worktree… once the task is marked. The setup's log stays in the console's
 * Setup worktree channel (#290: no ver log icon here or on the card). The step's own command stays on the task and in the log, never in the button. */
export function SetupSubmit({ label, pending, setup, disabled, onSubmit }: SetupSubmitProps) {
  const waiting = `${t(setup === undefined ? 'event.starting' : 'start.preparing')}…`;
  return <Button type="button" onClick={onSubmit} disabled={disabled === true || pending}>{pending ? waiting : label}</Button>;
}

const MUTED = 'text-muted-foreground';
// Colour only for status (design-system): working for running and done, destructive for failed, muted otherwise
const GLYPH: Record<SetupRowStatus, ReactNode> = { done: <CheckIcon className="size-3.5" />, running: '●', queued: '○', failed: '×' };
const TONE: Record<SetupRowStatus, string> = { done: 'text-working', running: 'text-working', queued: MUTED, failed: 'text-destructive' };
const EXIT_CODE = /^\d+$/;

/** The bar (#390): the rows done over all of them, the session row included. */
export const barValue = (rows: readonly SetupRow[], session: SetupRowStatus): number =>
  Math.round(((rows.filter((row) => row.status === 'done').length + (session === 'done' ? 1 : 0)) / (rows.length + 1)) * 100);

// A failed row's value (#390): a RUN's exit code, its timeout or stop, or nothing more for a git refusal or a COPY error
const failedText = (code: string | undefined): string => {
  if (code === undefined) return t('setupProgress.failed');
  return EXIT_CODE.test(code) ? t('setupProgress.failedExit', { code }) : t('setupProgress.failedWhy', { why: code });
};

// A row's value on the right (#390): its time, the running clock, na fila, or how it failed; a skipped step and the branch row show none
function rightOf(row: SetupRow, now: number): { text: string; tone: string } {
  if (row.status === 'running') return { text: t('setupProgress.running', { time: formatDuration(row.startedAt === undefined ? 0 : now - Date.parse(row.startedAt)) }), tone: 'text-working' };
  if (row.status === 'queued') return { text: t('setupProgress.queued'), tone: MUTED };
  if (row.status === 'failed') return { text: failedText(row.code), tone: 'text-destructive' };
  return { text: row.durationMs === undefined ? '' : formatDuration(row.durationMs), tone: MUTED };
}

const mono = (text: string): ReactNode => <span className="font-mono text-xs">{text}</span>;
// A row's text (#390): worktree criada, branch <branch> a partir de <base>, setup · <command>
function labelOf(row: SetupRow): ReactNode {
  if (row.kind === 'worktree') return t('setupProgress.row.worktree');
  if (row.kind === 'branch') return <>{t('setupProgress.row.branch')} {mono(row.branch ?? '')} {t('setupProgress.row.from', { base: row.base ?? '' })}</>;
  return <>{t('setupProgress.row.step')} {mono(row.label ?? '')}</>;
}

function Row({ status, label, value }: { status: SetupRowStatus; label: ReactNode; value?: { text: string; tone: string } }) {
  return (
    <li className={`flex items-center gap-2.5 text-[13px] ${status === 'queued' ? MUTED : ''}`}>
      <span aria-hidden="true" className={`flex w-4 flex-none justify-center ${TONE[status]}`}>{GLYPH[status]}</span>
      <span className="min-w-0 flex-1">{label}</span>
      {value !== undefined && value.text !== '' && <span className={`whitespace-nowrap text-xs ${value.tone}`}>{value.text}</span>}
    </li>
  );
}

// The log select's rows (#390): those that printed in this run; the branch row shares the worktree's git, a skipped step printed nothing
const hasLog = (row: SetupRow): boolean => row.kind === 'worktree' || (row.kind === 'step' && row.status !== 'queued' && !isSkipped(row));
// The row the log follows (#390): the running one, else the failed one, else the last that printed
function followedRow(rows: readonly SetupRow[]): number {
  const running = rows.findIndex((row) => row.status === 'running' && hasLog(row));
  if (running !== -1) return running;
  const failed = rows.findIndex((row) => row.status === 'failed' && hasLog(row));
  return failed !== -1 ? failed : rows.map(hasLog).lastIndexOf(true);
}

function LogOption({ row, index }: { row: SetupRow; index: number }) {
  return <SelectItem value={String(index)}>{row.kind === 'worktree' ? t('setupProgress.row.worktree') : row.label}</SelectItem>;
}

function LogLine({ text, isLast }: { text: string; isLast: boolean }) {
  if (!isLast) return <span className="truncate">{text}</span>;
  return <span className="truncate text-foreground">{text}<span aria-hidden="true" className="ml-0.5 inline-block h-3 w-1.5 bg-foreground align-[-2px]" /></span>;
}

// Keys (#390): the lists are only ever replaced whole and two entries can read alike, so the place tells them apart
const rowKey = (row: SetupRow, place: number): string => `${row.kind}:${place}`;
const lineKey = (line: string, place: number): string => `${place}:${line}`;

// The log box (#390): the picked row's last 4 lines, the last in foreground with a block cursor; abrir no console opens the run there and
// closes the dialog, which never stops the setup
function SetupLog({ progress, isLive, onOpened }: { progress: SetupRows; isLive: boolean; onOpened(): void }) {
  const tails = useSetupLog(progress.consoleId, progress.rows, isLive);
  const open = useOpenConsole();
  const [picked, setPicked] = useState<number>();
  const followed = followedRow(progress.rows);
  const shown = picked ?? followed;
  const lines = tails[shown] ?? [];
  const pick = (value: string): void => setPicked(Number(value) === followed ? undefined : Number(value)); // the running row again: follow it
  const openConsole = (): void => { open?.(SETUP_CHANNEL.id, progress.consoleId, true); onOpened(); };
  return (
    <div className="flex flex-col rounded-md border border-border bg-background">
      <div className={`flex items-center gap-2 border-border border-b px-2.5 py-1.5 text-xs ${MUTED}`}>
        <span className="text-foreground">{t('setupProgress.log')}</span>
        <Select value={String(shown)} onValueChange={pick}>
          <SelectTrigger size="sm" aria-label={t('setupProgress.log')} className="h-6 px-1.5 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{progress.rows.flatMap((row, i) => (hasLog(row) ? [<LogOption key={rowKey(row, i)} row={row} index={i} />] : []))}</SelectContent>
        </Select>
        <span className="flex-1" />
        {open && <button type="button" className="hover:text-foreground" onClick={openConsole}>{t('setupProgress.openConsole')}</button>}
      </div>
      <div className={`flex min-h-[72px] flex-col px-2.5 py-2 font-mono text-xs leading-[18px] ${MUTED}`}>
        {lines.map((line, i) => <LogLine key={lineKey(line, i)} text={line} isLast={i === lines.length - 1} />)}
      </div>
    </div>
  );
}

export interface SetupProgressViewProps {
  progress: SetupRows; // the live setup's, else the last failed one's
  isLive: boolean; // the run is the live setup's: the log reads it over its pty
  isFailed: boolean;
  session: { text: string; status: SetupRowStatus }; // the dialog's own row: what it launches
  onClose(): void;
  onRetry(): void;
}

/** The Start dialog's preparing view (#390, design_handoff_preparando): the bar, a row per step of the preparation and the session's, the log
 * tail, the note, fechar and the primary: the wait, or tentar de novo once a step failed. The title and subtitle are the dialog's. */
export function SetupProgressView({ progress, isLive, isFailed, session, onClose, onRetry }: SetupProgressViewProps) {
  useTick(progress.rows.some((row) => row.status === 'running'));
  const now = Date.now();
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <Progress value={barValue(progress.rows, session.status)} aria-label={t('setupProgress.preparing')} className="h-1 bg-muted" indicatorClassName="bg-working" />
        <ul className="flex flex-col gap-2.5">
          {progress.rows.map((row, i) => <Row key={rowKey(row, i)} status={row.status} label={labelOf(row)} value={rightOf(row, now)} />)}
          <Row status={session.status} label={session.text} />
        </ul>
      </div>
      <SetupLog progress={progress} isLive={isLive} onOpened={onClose} />
      <p className={`text-xs leading-4 ${MUTED}`}>{t('setupProgress.note')}</p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t('setupProgress.close')}<span aria-hidden="true" className={`ml-2 font-normal ${MUTED}`}>{t('setupProgress.esc')}</span></Button>
        <Button type="button" disabled={!isFailed} onClick={onRetry} className="disabled:opacity-60">
          {isFailed ? t('setupProgress.retry') : <><Spinner />{t('setupProgress.preparing')}</>}
        </Button>
      </DialogFooter>
    </>
  );
}
