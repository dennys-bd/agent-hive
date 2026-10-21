import type { Stage, StageCi, StageCommands, StageEvaluate } from '../../types.js';

// The running block's lines (#914): a wait's checks or a commands stage's commands, each with its mark and its times, a silent command's minutes
// and how a duration reads. Pure: the block passes the clock.

export type RunningMark = 'done' | 'failed' | 'skipped' | 'running' | 'queued';
export interface RunningLine { name: string; mark: RunningMark; startedAt?: string; endedAt?: string; url?: string }

/** How long the current command may write nothing before the block says so (#914): a constant, not a setting. */
export const SILENCE_MS = 2 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_S = 3600;
const MINUTE_S = 60;

// '' is a start the State never got: a pty that never started
const known = (time: string | undefined): string | undefined => (time === undefined || time === '' ? undefined : time);
const timed = (startedAt: string | undefined, endedAt: string | undefined): Pick<RunningLine, 'startedAt' | 'endedAt'> =>
  ({ ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }) });

/** A wait's checks in the order the last read wrote them (#914): success done, failure failed, pending with a start running, else queued. */
export function ciLines(ci: Pick<StageCi, 'checks'>): RunningLine[] {
  return (ci.checks ?? []).map((check) => {
    const mark: RunningMark = check.state === 'success' ? 'done' : check.state === 'failure' ? 'failed' : check.startedAt === undefined ? 'queued' : 'running';
    return { name: check.name, mark, ...timed(check.startedAt, check.completedAt), ...(check.url === undefined ? {} : { url: check.url }) };
  });
}

// Before the current command: skipped, failed (named in failed; a stage's names are distinct) or done; the current one runs; the rest queue
function commandMark(run: StageCommands, name: string, index: number): RunningMark {
  if (index > run.at) return 'queued';
  if (index === run.at) return 'running';
  if (run.skipped?.includes(index) === true) return 'skipped';
  return run.failed.some((f) => f.name === name) ? 'failed' : 'done';
}

/** A commands stage's commands in the stage's order (#914): a finished one ends where the next one started; a skipped or queued one has no time. */
export function commandLines(run: StageCommands, names: readonly string[]): RunningLine[] {
  return names.map((name, index) => {
    const mark = commandMark(run, name, index);
    const startedAt = mark === 'queued' || mark === 'skipped' ? undefined : known(run.started[index]);
    const endedAt = mark === 'done' || mark === 'failed' ? known(run.started[index + 1]) : undefined;
    return { name, mark, ...timed(startedAt, endedAt) };
  });
}

/** The whole minutes the current command has written nothing (#914), since its last output, else its start; undefined under SILENCE_MS or with
 * neither. The server's 30 s throttle can make it show up to 30 s early. */
export function silence(run: StageCommands, now: number): number | undefined {
  const since = known(run.outputAt) ?? known(run.started[run.at]);
  if (since === undefined) return undefined;
  const quiet = now - Date.parse(since);
  return quiet >= SILENCE_MS ? Math.floor(quiet / MINUTE_MS) : undefined;
}

/** {s}s, {m}m {s}s or {h}h {m}m (#914); a negative span, a clock skew, reads 0s. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const [hours, minutes, seconds] = [Math.floor(total / HOUR_S), Math.floor((total % HOUR_S) / MINUTE_S), total % MINUTE_S];
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** A line's time (#914): a running line's so far, a finished one's span; none without both ends. */
export function lineDuration(line: RunningLine, now: number): string | undefined {
  if (line.startedAt === undefined) return undefined;
  if (line.mark === 'running') return formatDuration(now - Date.parse(line.startedAt));
  return line.endedAt === undefined ? undefined : formatDuration(Date.parse(line.endedAt) - Date.parse(line.startedAt));
}

/** An evaluation's runs (#877): each reviewer as `<agent> · <focus>`, running from the stage's start while it reviews, done once the judge runs;
 * the judge after them, queued, then running. The reducer knows the phase only, so a finished reviewer shows no time. */
export function evaluateLines(run: StageEvaluate, stage: Pick<Stage, 'reviewers' | 'judge'> | undefined, judgeLabel: string): RunningLine[] {
  const reviewing = run.phase === 'reviewing';
  const reviewers = (stage?.reviewers ?? []).map((r): RunningLine => ({ name: `${r.agent} · ${r.focus ?? ''}`, mark: reviewing ? 'running' : 'done', ...(reviewing ? { startedAt: run.startedAt } : {}) }));
  const judge: RunningLine = { name: `${judgeLabel} · ${stage?.judge?.agent ?? ''}`, mark: reviewing ? 'queued' : 'running' };
  return [...reviewers, judge];
}
