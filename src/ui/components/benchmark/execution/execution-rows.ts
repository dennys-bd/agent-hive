// The execution tab's pure parts (#465): the round bands in the screen's order, the queued rounds derived from the pace (a BenchRound exists
// only once started, #472), and each card's fields. Tested without rendering.
import type { Arm, BenchRound, BenchRun, BenchRunStatus, Experiment, TaskProgressState } from '../../../../types';
import { t } from '@/i18n';
import { clockOf } from '@/lib/design-comments';

export type RoundKind = 'running' | 'ended' | 'queued';
export type CardAction = 'open' | 'result';
export interface RunCardRow {
  key: string; letter: string; token?: string; shortToken: string; status: BenchRunStatus; segments: TaskProgressState[];
  delivered: number; total: number; tokens?: number; ms?: number; action?: CardAction;
}
export interface RoundRow { n: number; kind: RoundKind; sub: string; cards: RunCardRow[] }

const TOKEN_CHARS = 6;
const QUEUED_TOKEN = '—';
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const ENDED: readonly BenchRunStatus[] = ['done', 'timeout', 'error', 'interrupted'];
// abrir while the run's Hive lives, resultado once it ended (an interrupted run was rerun under a new token: its card stays as history)
const ACTION: Partial<Record<BenchRunStatus, CardAction>> = {
  running: 'open', waiting: 'open', sleeping: 'open', done: 'result', timeout: 'result', error: 'result', interrupted: 'result',
};

const at = (iso: string): number => Date.parse(iso);
const clock = (iso: string | undefined): string => (iso === undefined ? '' : clockOf(new Date(iso)));

/** 3h12: whole hours and two-digit minutes. */
export function hoursMinutes(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h${String(minutes % MINUTES_PER_HOUR).padStart(2, '0')}`;
}

/** now − the first round's start − the experiment's time asleep (an open sleep counted to now); undefined before any round started. */
export function elapsedMs(e: Experiment, now: number): number | undefined {
  const first = e.rounds.find((r) => r.startedAt !== undefined)?.startedAt;
  if (first === undefined) return undefined;
  const slept = e.sleeps.reduce((sum, s) => sum + (s.wokeAt === undefined ? now : at(s.wokeAt)) - at(s.at), 0);
  return now - at(first) - slept;
}

/** The run's bar: its progress, else (none reported yet) all open, or all green once done. */
export const segmentsOf = (run: BenchRun): TaskProgressState[] =>
  run.progress ?? Array.from({ length: run.total }, (): TaskProgressState => (run.status === 'done' ? 'done' : 'open'));

// The experiment's sleep still open: sleptMs is only added at the wake (#472), so until then the card leaves it out here
const openSleepMs = (e: Experiment, now: number): number => e.sleeps.reduce((sum, s) => sum + (s.wokeAt === undefined ? now - at(s.at) : 0), 0);

// An ended run's measured time; a live run's metrics carry its tokens only (ms 0 until its end), so its clock runs here
function msOf(e: Experiment, run: BenchRun, now: number): number | undefined {
  if (ENDED.includes(run.status)) return run.metrics?.ms;
  return run.startedAt === undefined ? undefined : now - at(run.startedAt) - run.sleptMs - openSleepMs(e, now);
}

function cardOf(e: Experiment, run: BenchRun, now: number): RunCardRow {
  return {
    key: run.token, letter: e.arms.find((a) => a.id === run.armId)?.letter ?? '', token: run.token, shortToken: run.token.slice(0, TOKEN_CHARS),
    status: run.status, segments: segmentsOf(run), delivered: run.delivered, total: run.total, tokens: run.metrics?.tokens, ms: msOf(e, run, now),
    action: ACTION[run.status],
  };
}

function queuedCard(e: Experiment, arm: Arm): RunCardRow {
  const total = (arm.overrides.tasks ?? e.base.tasks).length;
  return { key: arm.id, letter: arm.letter, shortToken: QUEUED_TOKEN, status: 'queued', segments: Array.from({ length: total }, (): TaskProgressState => 'open'), delivered: 0, total };
}

function startedRow(e: Experiment, round: BenchRound, now: number): RoundRow {
  const armIndex = (run: BenchRun): number => e.arms.findIndex((a) => a.id === run.armId);
  const cards = [...round.runs].sort((a, b) => armIndex(a) - armIndex(b)).map((run) => cardOf(e, run, now)); // a copy: the state's array is never sorted
  if (round.endedAt === undefined) return { n: round.n, kind: 'running', sub: t('benchmark.execution.sub.started', { time: clock(round.startedAt) }), cards };
  const evaluation = t(round.evaluatedAt === undefined ? 'benchmark.execution.sub.evaluating' : 'benchmark.execution.sub.evaluated');
  return { n: round.n, kind: 'ended', sub: `${clock(round.startedAt)} → ${clock(round.endedAt)} · ${evaluation}`, cards };
}

// The first queued round names no round before it: just na fila
function queuedSub(n: number, until: string | undefined): string {
  if (n === 1) return t('benchmark.execution.sub.queued');
  const after = t('benchmark.execution.sub.queuedAfter', { n: n - 1 });
  return until === undefined ? after : `${after}${t('benchmark.execution.sub.ifBefore', { time: until })}`;
}

/** The bands as the screen orders them (2, 1, 3): the running round, the ended ones newest first, then the queued ones, every n from
 *  rounds.length + 1 to pace.pairs. */
export function roundRows(e: Experiment, now: number): RoundRow[] {
  const started = e.rounds.map((round) => startedRow(e, round, now));
  const newestFirst = (a: RoundRow, b: RoundRow): number => b.n - a.n;
  const queued = Array.from({ length: Math.max(0, e.pace.pairs - e.rounds.length) }, (_, i): RoundRow => {
    const n = e.rounds.length + 1 + i;
    return { n, kind: 'queued', sub: queuedSub(n, e.pace.until), cards: e.arms.map((arm) => queuedCard(e, arm)) };
  });
  return [...started.filter((r) => r.kind === 'running').sort(newestFirst), ...started.filter((r) => r.kind === 'ended').sort(newestFirst), ...queued];
}
