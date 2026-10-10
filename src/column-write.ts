import type { ColumnWrite, Task } from './types.js';

// The Hive's own column writes against the polls that lag behind them (#889). Here and not in tasks.ts, which is already over its size,
// and with no Node import, so the reducer and tasks.ts can both use it.

/** How long a write holds against a poll still showing the column from before it: about four polls of POLL_INTERVAL_MS, long enough for
 * GitHub Projects' lag (#861), short enough that a failed write or a deliberate move back on the source is followed soon. */
export const COLUMN_WRITE_TIMEOUT_MS = 2 * 60_000;

// The task's mark when it has the shape the code relies on: it comes back from the saved state file unchecked, and a hand-edited or
// damaged one must not make every poll of the source throw
const markOf = (task: Task): ColumnWrite | undefined => (Array.isArray(task.columnWrite?.stale) ? task.columnWrite : undefined);

/** The task once the Hive wrote `column` at `now`: the column follows along (shouldWrite compares the next target with it), and the mark
 * lists every column a stale poll may still show. A write over an unconfirmed one keeps that one's stale columns and adds its target. */
export function withColumnWrite(task: Task, column: string, now: string): Task {
  const mark = markOf(task);
  const before = mark === undefined ? [task.boardColumn] : [...mark.stale, mark.column];
  const stale = [...new Set(before)].filter((c) => c !== '' && c !== column);
  return { ...task, boardColumn: column, columnWrite: { column, stale, at: now } };
}

/** Whether a poll showing `column` at `now` is a read from before the Hive's write. A human who moves the item back to a stale column
 * inside the window looks the same, so that move waits for the mark to expire. An unreadable stamp holds nothing, and neither does one in
 * the future (the clock stepped back): it would otherwise hold for as long as the step. */
export function staleRead(task: Task, column: string, now: string): boolean {
  const mark = markOf(task);
  if (!mark?.stale.includes(column)) return false;
  const elapsed = Date.parse(now) - Date.parse(mark.at);
  return elapsed >= 0 && elapsed < COLUMN_WRITE_TIMEOUT_MS;
}
