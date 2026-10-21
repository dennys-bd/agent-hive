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
import { opensRow, useSetupLog } from '@/hooks/use-setup-log';
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
// A done nested repo's branch end (#450): from its base, or reaproveitada when its branch was checked out as it was
const nestedFrom = (row: SetupRow): string => (row.base === undefined ? t('setupProgress.row.reused') : t('setupProgress.row.from', { base: row.base }));
// A row's text (#390, #450): worktree criada, branch <branch> a partir de <base>, setup · <command>
function labelOf(row: SetupRow): ReactNode {
  if (row.kind === 'worktree') return t('setupProgress.row.worktree');
  if (row.kind === 'branch') return <>{t('setupProgress.row.branch')} {mono(row.branch ?? '')} {t('setupProgress.row.from', { base: row.base ?? '' })}</>;
  if (row.kind === 'nested') return <>{t('setupProgress.row.nested')} {mono(row.label ?? '')}{row.branch !== undefined && <> · {t('setupProgress.row.branch')} {mono(row.branch)} {nestedFrom(row)}</>}</>;
  return <>{t('setupProgress.row.step')} {mono(row.label ?? '')}</>;
}

// A row's full text (#893): the title of a row its one line may cut, a branch's name or a setup step's command
function titleOf(row: SetupRow): string | undefined {
  if (row.kind === 'branch') return `${t('setupProgress.row.branch')} ${row.branch ?? ''} ${t('setupProgress.row.from', { base: row.base ?? '' })}`;
  if (row.kind === 'nested') return `${t('setupProgress.row.nested')} ${row.label ?? ''}${row.branch === undefined ? '' : ` · ${t('setupProgress.row.branch')} ${row.branch} ${nestedFrom(row)}`}`;
  if (row.kind === 'step') return `${t('setupProgress.row.step')} ${row.label ?? ''}`;
  return undefined;
}

// One line per row (#893): a multi-line RUN filled the dialog, so the text cuts with an ellipsis and the value column never gives way
function Row({ status, label, title, value }: { status: SetupRowStatus; label: ReactNode; title?: string; value?: { text: string; tone: string } }) {
  return (
    <li title={title} className={`flex items-center gap-2.5 text-[13px] ${status === 'queued' ? MUTED : ''}`}>
      <span aria-hidden="true" className={`flex w-4 flex-none justify-center ${TONE[status]}`}>{GLYPH[status]}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value !== undefined && value.text !== '' && <span className={`flex-none whitespace-nowrap text-xs ${value.tone}`}>{value.text}</span>}
    </li>
  );
}

// The log select's rows (#390, #450): those that printed in this run; the branch row shares the worktree's git, a skipped step and a
// queued row printed nothing
const hasLog = (row: SetupRow): boolean => row.kind === 'worktree' || (opensRow(row) && row.status !== 'queued');
// The row the log follows (#390): the running one, else the failed one, else the last that printed
function followedRow(rows: readonly SetupRow[]): number {
  const running = rows.findIndex((row) => row.status === 'running' && hasLog(row));
  if (running !== -1) return running;
  const failed = rows.findIndex((row) => row.status === 'failed' && hasLog(row));
  return failed !== -1 ? failed : rows.map(hasLog).lastIndexOf(true);
}

// A log option's text (#390, #450): the worktree's, a nested repo's path after its name, a step's command
function logText(row: SetupRow): string {
  if (row.kind === 'worktree') return t('setupProgress.row.worktree');
  if (row.kind === 'nested') return `${t('setupProgress.row.nested')} ${row.label ?? ''}`;
  return row.label ?? '';
}

function LogOption({ row, index }: { row: SetupRow; index: number }) {
  const text = logText(row);
  // The last span of the item is Radix's ItemText: it needs min-w-0 so the truncate inside it can cut a long command
  return <SelectItem value={String(index)} title={text} className="*:[span]:last:min-w-0"><span className="truncate">{text}</span></SelectItem>;
}

// The log's step select (#390, #893): it opens under its trigger and never wider than the log box, every command on one line with its full
// text in title; the trigger cuts at 60% of the header. Item-aligned took the window's width and wrapped the commands
function LogSelect({ rows, shown, box, onPick }: { rows: readonly SetupRow[]; shown: number; box: HTMLElement | null; onPick(value: string): void }) {
  return (
    <Select value={String(shown)} onValueChange={onPick}>
      <SelectTrigger size="sm" aria-label={t('setupProgress.log')} className="h-6 min-w-0 max-w-[60%] px-1.5 text-xs"><SelectValue className="min-w-0" /></SelectTrigger>
      <SelectContent position="popper" align="start" collisionBoundary={box} collisionPadding={0} className="max-w-(--radix-select-content-available-width)">
        {rows.flatMap((row, i) => (hasLog(row) ? [<LogOption key={rowKey(row, i)} row={row} index={i} />] : []))}
      </SelectContent>
    </Select>
  );
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
  const [box, setBox] = useState<HTMLDivElement | null>(null); // the popper reads it at render, so a callback ref held in state
  const followed = followedRow(progress.rows);
  const shown = picked ?? followed;
  const lines = tails[shown] ?? [];
  const pick = (value: string): void => setPicked(Number(value) === followed ? undefined : Number(value)); // the running row again: follow it
  const openConsole = (): void => { open?.(SETUP_CHANNEL.id, progress.consoleId, true); onOpened(); };
  return (
    <div ref={setBox} className="flex flex-col rounded-md border border-border bg-background">
      <div className={`flex items-center gap-2 border-border border-b px-2.5 py-1.5 text-xs ${MUTED}`}>
        <span className="text-foreground">{t('setupProgress.log')}</span>
        <LogSelect rows={progress.rows} shown={shown} box={box} onPick={pick} />
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
  error?: string; // #390: why the request was refused, which no row may say (a spawn refused after the setup passed, a git refusal)
  session: { text: string; status: SetupRowStatus }; // the dialog's own row: what it launches
  onClose(): void;
  onRetry(): void;
}

/** The Start dialog's preparing view (#390, design_handoff_preparando): the bar, a row per step of the preparation and the session's, the log
 * tail, the note, fechar and the primary: the wait, or tentar de novo once a step failed. The title and subtitle are the dialog's. */
export function SetupProgressView({ progress, isLive, isFailed, error, session, onClose, onRetry }: SetupProgressViewProps) {
  useTick(progress.rows.some((row) => row.status === 'running'));
  const now = Date.now();
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <Progress value={barValue(progress.rows, session.status)} aria-label={t('setupProgress.preparing')} className="h-1 bg-muted" indicatorClassName="bg-working" />
        <ul className="flex flex-col gap-2.5">
          {progress.rows.map((row, i) => <Row key={rowKey(row, i)} status={row.status} label={labelOf(row)} title={titleOf(row)} value={rightOf(row, now)} />)}
          <Row status={session.status} label={session.text} />
        </ul>
      </div>
      <SetupLog progress={progress} isLive={isLive} onOpened={onClose} />
      <p className={`text-xs leading-4 ${MUTED}`}>{t('setupProgress.note')}</p>
      {error && <p role="alert" className="whitespace-pre-line text-destructive text-sm">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t('setupProgress.close')}<span aria-hidden="true" className={`ml-2 font-normal ${MUTED}`}>{t('setupProgress.esc')}</span></Button>
        <Button type="button" disabled={!isFailed} onClick={onRetry} className="disabled:opacity-60">
          {isFailed ? t('setupProgress.retry') : <><Spinner />{t('setupProgress.preparing')}</>}
        </Button>
      </DialogFooter>
    </>
  );
}
