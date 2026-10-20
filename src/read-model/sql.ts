import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { PrState, ProjectPr, Signal } from '../types.js';
import type { IssueRow, UpsertOrigin } from './rows.js';

// What every table's code reads and writes a row with (#178, #186, #187): shared by db.ts, pull-tables.ts and pr-details.ts

/** #178's window: a sync page tied with a write's row loses to it for this long, by the daemon's clock. */
export const WRITE_WINDOW_MS = 30_000;
const PR_STATES: readonly PrState[] = ['open', 'merged', 'closed'];
const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];
const KEY: readonly string[] = ['source', 'node_id'];

/** A row as node:sqlite answers it. */
export type Row = Record<string, SQLOutputValue>;
export const text = (row: Row, key: string): string => String(row[key]);
export const nullable = (row: Row, key: string): string | null => (row[key] === null ? null : String(row[key]));
export const written = (result: { changes: number | bigint }): boolean => Number(result.changes) > 0;
/** A column's named parameter: snake_case to camelCase, as the rows' keys are. */
export const paramOf = (column: string): string => column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
/** The replace rule's clock values: written_at is stamped only by a write's answer. */
export const stamp = (at: number, origin: UpsertOrigin): { now: number; writtenAt: number | null } => ({ now: at, writtenAt: origin === 'write' ? at : null });

/** The replace rule (#178): a newer `at` (updated_at; a review's submitted_at, #187) always wins. On a tie a write wins, and a sync page wins
 * unless the stored row was written less than WRITE_WINDOW_MS ago by the daemon's clock: a page read before a write can carry the write's own
 * second. An identical row (written_at aside) writes nothing, so a quiet page costs no disk write. */
export function upsertSql(table: string, columns: readonly string[], at = 'updated_at'): string {
  const compared = columns.filter((c) => !KEY.includes(c));
  const set = [...compared, 'written_at'].map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}, written_at) VALUES (${columns.map((c) => `$${paramOf(c)}`).join(', ')}, $writtenAt)
  ON CONFLICT (source, node_id) DO UPDATE SET ${set}
  WHERE (${compared.map((c) => `excluded.${c}`).join(', ')}) IS NOT (${compared.map((c) => `${table}.${c}`).join(', ')})
    AND (excluded.${at} > ${table}.${at} OR (excluded.${at} = ${table}.${at}
      AND (excluded.written_at IS NOT NULL OR ${table}.written_at IS NULL OR $now - ${table}.written_at >= ${WRITE_WINDOW_MS})))`;
}

/** A savepoint, not BEGIN: the replace-whole writers open their own, and a caller may already hold db.transaction around them. */
export function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('SAVEPOINT read_model');
  try {
    const result = run();
    db.exec('RELEASE read_model');
    return result;
  } catch (err) {
    db.exec('ROLLBACK TO read_model');
    db.exec('RELEASE read_model');
    throw err;
  }
}

/** An issues row as stored: an issue or a PR. */
export function issueOf(row: Row): IssueRow {
  return {
    source: text(row, 'source'), nodeId: text(row, 'node_id'), repository: text(row, 'repository'), number: Number(row.number),
    kind: row.kind === 'pr' ? 'pr' : 'issue', state: row.state === 'closed' ? 'closed' : 'open', title: text(row, 'title'), body: text(row, 'body'),
    author: nullable(row, 'author'), labels: JSON.parse(text(row, 'labels')) as string[], assignees: JSON.parse(text(row, 'assignees')) as string[],
    createdAt: text(row, 'created_at'), updatedAt: text(row, 'updated_at'), closedAt: nullable(row, 'closed_at'), comments: Number(row.comments),
  };
}

/** A closing PR as stored (#178). The stored values are the module's own writes, through pullRequest's shape. */
export function prOf(row: Row): ProjectPr {
  const checks = SIGNALS.find((s) => s === row.checks);
  return {
    number: Number(row.number), url: text(row, 'url'), state: PR_STATES.find((s) => s === row.state) ?? 'closed',
    ...(checks === undefined ? {} : { checks }), ...(row.draft === 1 ? { draft: true as const } : {}),
  };
}

/** Rows grouped by one column's value, each mapped (#282): one query's rows for many items, read in one pass. */
export function groupBy<T>(rows: Row[], key: string, map: (row: Row) => T): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(text(row, key), [...(groups.get(text(row, key)) ?? []), map(row)]);
  return groups;
}
