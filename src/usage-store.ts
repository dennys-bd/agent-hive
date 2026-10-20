import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { EVENTS_FILE, type EventName, type EventRecord } from './events.js';
import type { Logger } from './log.js';
import { isRecord } from './rate-limits.js';
import { migrate, restrict } from './read-model/db.js';
import { inTransaction } from './read-model/sql.js';

// usage.sqlite (#271): the usage, intervention and outcome records of events.jsonl, kept for good beside it. events.jsonl rotates at 5 MB; this
// file never rotates and the Hive never deletes it: a file it cannot open or write turns the store off with one hive.log line and is left as it
// is. One row per record, its correlation as columns and the whole record as JSON, so any later question (per day, task, stage, agent, model)
// is one query. Cost and the planned/unplanned split are the query's: no price and no rule is stored.

export const USAGE_FILE = 'usage.sqlite';
const FILE_MODE = 0o600; // the user's own history, as the read model's

/** The events the store keeps (#271): usage, the interventions, and the outcomes they are counted against. */
export const KEPT_EVENTS: readonly EventName[] = [
  'stage.ended', 'free_session.ended',
  'run.takeover', 'run.stopped', 'run.restarted', 'task.moved', 'question.answered', 'permission.answered',
  'approval.granted', 'approval.rejected', 'approval.extended', 'approval.expired',
  'run.spawned', 'task.discovered', 'task.closed', 'task.deleted', 'pr.opened', 'pr.state',
];

// One entry per version, as the read model's schema.ts: appended, never edited
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE records (ts TEXT NOT NULL, event TEXT NOT NULL, task_id TEXT, task TEXT, activity_id TEXT, stage TEXT, session_id TEXT,
    attempt INTEGER, run_kind TEXT, agent TEXT, data TEXT NOT NULL);
  CREATE INDEX records_by_ts ON records (ts);
  CREATE INDEX records_by_task ON records (task_id, ts);`,
];
const COLUMNS = ['task_id', 'task', 'activity_id', 'stage', 'session_id', 'attempt', 'run_kind', 'agent'] as const;
const INSERT = `INSERT INTO records (ts, event, ${COLUMNS.join(', ')}, data) VALUES ($ts, $event, ${COLUMNS.map((c) => `$${c}`).join(', ')}, $data)`;

export interface UsageStore { write(record: EventRecord): void; close(): void }
type ErrorLog = Pick<Logger, 'error'>;
type Cell = string | number | null;

const OFF: UsageStore = { write: () => undefined, close: () => undefined };
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isKept = (event: unknown): boolean => KEPT_EVENTS.some((name) => name === event);
// A column's value: a string or a number as it is, anything else NULL (absent, or an imported line's odd field), so no row fails on its type
const cell = (value: unknown): Cell => (typeof value === 'string' || typeof value === 'number' ? value : null);

// Takes the record's fields by name: a column is absent on the events that carry none, and an imported line is not typed
function rowOf(fields: Record<string, unknown>): Record<string, Cell> {
  return { ts: cell(fields.ts), event: cell(fields.event), ...Object.fromEntries(COLUMNS.map((c) => [c, cell(fields[c])])), data: JSON.stringify(fields) };
}

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // a half-written or hand-edited line
  }
};

// A file's kept records: a line that does not parse, or names no kept event and no ts, is skipped. A file missing or unreadable adds nothing:
// the import is the best the rotated history allows
function keptLines(path: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line): Record<string, unknown>[] => {
    const value = parsed(line);
    return isRecord(value) && typeof value.ts === 'string' && isKept(value.event) ? [value] : [];
  });
}

// The history events.jsonl.1 then events.jsonl still hold, oldest first (#271): they rotate away within a week
function importLogs(home: string, insert: StatementSync): void {
  for (const file of [`${EVENTS_FILE}.1`, EVENTS_FILE]) for (const record of keptLines(join(home, file))) insert.run(rowOf(record));
}

// write never throws: the first failure turns the store off with one line, the file left as it is; close closes the handle once
function storeOf(db: DatabaseSync, log: ErrorLog): UsageStore {
  const insert = db.prepare(INSERT);
  let isOn = true;
  let isClosed = false;
  return {
    write: (record) => {
      if (!isOn || !isKept(record.event)) return;
      try {
        insert.run(rowOf({ ...record }));
      } catch (err) {
        isOn = false;
        log.error(`usage store: off after a failed write, nothing more is kept: ${errorText(err)}`);
      }
    },
    close: () => {
      if (isClosed) return;
      isClosed = true;
      isOn = false;
      db.close();
    },
  };
}

// The migration and the first open's import share one savepoint: a failed import rolls the table back too, so the next boot tries both again
function storeAt(Database: typeof DatabaseSync, home: string, log: ErrorLog): UsageStore {
  const path = join(home, USAGE_FILE);
  closeSync(openSync(path, 'a', FILE_MODE)); // owner-only before sqlite creates it; an existing file is neither truncated nor rewritten
  const db = new Database(path);
  try {
    db.exec('PRAGMA journal_mode = WAL'); // a sqlite3 reader never blocks the Hive's writes
    const isNew = Number(db.prepare('PRAGMA user_version').get()?.user_version) === 0;
    inTransaction(db, () => {
      migrate(db, MIGRATIONS, 'usage store');
      if (isNew) importLogs(home, db.prepare(INSERT));
    });
    restrict(path);
    return storeOf(db, log);
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Opens usage.sqlite in `home` (#271), creating it on first use with the history the events files still hold. node:sqlite is imported here,
 * as openReadModel does. Never rejects: a file it cannot open (not a database, a newer schema, a disk error) gives a store that keeps nothing,
 * with one error line, and is never deleted. */
export async function openUsageStore(home: string, log: ErrorLog): Promise<UsageStore> {
  try {
    const { DatabaseSync: Database } = await import('node:sqlite');
    return storeAt(Database, home, log);
  } catch (err) {
    log.error(`usage store: off, nothing is kept: ${errorText(err)}`);
    return OFF;
  }
}
