// The rows of a worktree preparation as the Start dialog shows them (#390): the worktree, its branch and each nested repo (#450) and one per setup step after LOAD's
// expansion. Pure: task-setup.ts holds a run's list and dispatches it on each change. Each function answers the same array when nothing changed.
import type { WorkspaceBase } from './fork.js';
import type { SetupRow } from './types.js';
import type { StepReport } from './worktree-steps.js';
import type { NestedEnd } from './worktree-nested.js';

const RUN = 'RUN ';

/** The base a branch row names (#390): the start's chosen base, else the workspace's base branch on its remote, else the remote, whose
 * HEAD git resolves later (defaultBase). */
export const shownBase = (chosen: string | undefined, base: Pick<WorkspaceBase, 'remote' | 'branch'>): string =>
  chosen ?? (base.branch === undefined ? base.remote : `${base.remote}/${base.branch}`);

/** A nested repo's header (#450): the line the run writes after `> ` before that repo's first git, where the dialog cuts its log. */
export const nestedHeader = (path: string): string => `nested ${path}`;

/** The worktree and branch rows, running from the mark (#390): the git that makes the worktree makes the branch. Then each nested repo's
 * row, queued (#450), in the order the preparation runs them, so the bar counts them from the first moment. */
export const worktreeRows = (branch: string, base: string, at: string, nested: readonly string[] = []): SetupRow[] => [
  { kind: 'worktree', status: 'running', startedAt: at },
  { kind: 'branch', status: 'running', startedAt: at, branch, base },
  ...nested.map((path): SetupRow => ({ kind: 'nested', status: 'queued', label: path, header: nestedHeader(path) })),
];

// A running row ended as `status` at `at`: its time, except the branch row's, which shows none (the handoff draws it so)
function ended(row: SetupRow, status: 'done' | 'failed', at: number): SetupRow {
  const { startedAt, ...rest } = row;
  const time = row.kind === 'branch' || startedAt === undefined ? {} : { durationMs: Math.max(0, at - Date.parse(startedAt)) };
  return { ...rest, status, ...time };
}

// #450: only the outer git's rows; a nested row ends on its own, after them
const isPreparing = (row: SetupRow): boolean => (row.kind === 'worktree' || row.kind === 'branch') && row.status === 'running';

/** The worktree made (#390): its two rows done. */
export const preparedRows = (rows: SetupRow[], at: number): SetupRow[] =>
  (rows.some(isPreparing) ? rows.map((row) => (isPreparing(row) ? ended(row, 'done', at) : row)) : rows);

// The nested row of `path` changed; the same array when no row is that repo's, so the tracker dispatches nothing
function atNested(rows: SetupRow[], path: string, change: (row: SetupRow) => SetupRow): SetupRow[] {
  const isIt = (row: SetupRow): boolean => row.kind === 'nested' && row.label === path;
  return rows.some(isIt) ? rows.map((row) => (isIt(row) ? change(row) : row)) : rows;
}

/** A nested repo starts (#450). */
export const nestedStartedRows = (rows: SetupRow[], path: string, at: string): SetupRow[] =>
  atNested(rows, path, (row) => ({ ...row, status: 'running', startedAt: at }));

/** A nested repo done (#450): its time, the task's branch, and the base it started from; a reused branch names none. */
export const nestedEndedRows = (rows: SetupRow[], path: string, end: NestedEnd, branch: string, at: number): SetupRow[] =>
  atNested(rows, path, (row) => ({ ...ended(row, 'done', at), branch, ...('base' in end ? { base: end.base } : {}) }));

/** A nested repo that refused before it started (#450, switchNested's checks): failed, with no time. */
export const nestedFailedRows = (rows: SetupRow[], path: string, at: number): SetupRow[] => atNested(rows, path, (row) => ended(row, 'failed', at));

/** The expanded steps as describeStep writes them (#390): those a resume skips done with no time, the rest queued. */
export const plannedRows = (rows: SetupRow[], steps: string[], skipped: number): SetupRow[] => [
  ...rows.filter((row) => row.kind !== 'step'),
  ...steps.map((header, i): SetupRow => ({ kind: 'step', status: i < skipped ? 'done' : 'queued', header, label: header.startsWith(RUN) ? header.slice(RUN.length) : header })),
];

/** The next queued step starts (#390). */
export function startedRows(rows: SetupRow[], at: string): SetupRow[] {
  const next = rows.findIndex((row) => row.kind === 'step' && row.status === 'queued');
  return next === -1 ? rows : rows.map((row, i): SetupRow => (i === next ? { ...row, status: 'running', startedAt: at } : row));
}

/** A step's report (#390): its row, by its place among the steps, done or failed with the report's time and a RUN's code. */
export function endedRows(rows: SetupRow[], report: StepReport): SetupRow[] {
  const first = rows.findIndex((row) => row.kind === 'step');
  if (first === -1) return rows;
  return rows.map((row, i): SetupRow => {
    if (i !== first + report.index) return row;
    const { startedAt: _startedAt, ...rest } = row;
    return { ...rest, status: report.ok ? 'done' : 'failed', durationMs: report.durationMs, ...(report.code === undefined ? {} : { code: String(report.code) }) };
  });
}

/** A run that failed (#390): its running rows fail with their time; a failure no row was running for (a LOAD that does not read, a stop
 * between two steps) fails the next queued row, else the last, so a failed setup always holds a failed row. */
export function failedRows(rows: SetupRow[], at: number): SetupRow[] {
  if (rows.some((row) => row.status === 'failed')) return rows;
  if (rows.some((row) => row.status === 'running')) return rows.map((row) => (row.status === 'running' ? ended(row, 'failed', at) : row));
  const next = rows.findIndex((row) => row.status === 'queued');
  const target = next === -1 ? rows.length - 1 : next;
  return rows.map((row, i): SetupRow => (i === target ? { ...row, status: 'failed' } : row));
}
