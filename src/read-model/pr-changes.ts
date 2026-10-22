import type { DatabaseSync } from 'node:sqlite';
import type { ReadModel } from './db.js';
import type { PullChangesRow } from './rows.js';
import { text, written } from './sql.js';

// The EXISTS keeps a PR that is not open out: the triggers drop its row, and a revalidation finishing after the close must not bring it back.
// The changed-row guard makes an identical read no write, so setPrChanges answers whether the page has anything new
const UPSERT = `INSERT INTO pull_changes (source, repository, number, head, diff, details, read_at)
  SELECT $source, $repository, $number, $head, $diff, $details, $readAt
  WHERE EXISTS (SELECT 1 FROM issues WHERE source = $source AND repository = $repository AND number = $number AND kind = 'pr' AND state = 'open')
  ON CONFLICT (source, repository, number) DO UPDATE SET head = excluded.head, diff = excluded.diff, details = excluded.details, read_at = excluded.read_at
  WHERE (excluded.head, excluded.diff, excluded.details) IS NOT (pull_changes.head, pull_changes.diff, pull_changes.details)`;

type Details = Omit<PullChangesRow, 'head' | 'diff'>;

// One key order for every write, so the same read serializes to the same text and the guard sees no change
const detailsOf = (row: PullChangesRow): string => JSON.stringify({
  threads: row.threads, truncated: row.truncated, ...(row.behindBy === undefined ? {} : { behindBy: row.behindBy }), requestTimes: row.requestTimes,
});

/** The PR page's changes (#497), as db.ts's model spreads them. The stored JSON is this module's own write, so it is read back as its type. */
export function prChangesOf(db: DatabaseSync, now: () => number): Pick<ReadModel, 'prChanges' | 'setPrChanges'> {
  const read = db.prepare('SELECT head, diff, details FROM pull_changes WHERE source = ? AND repository = ? AND number = ?');
  const upsert = db.prepare(UPSERT);
  return {
    prChanges: (source, repository, number) => {
      const row = read.get(source, repository, number);
      if (row === undefined) return undefined;
      return { head: text(row, 'head'), diff: text(row, 'diff'), ...(JSON.parse(text(row, 'details')) as Details) };
    },
    setPrChanges: (source, repository, number, row) => written(upsert.run({
      source, repository, number, head: row.head, diff: row.diff, details: detailsOf(row), readAt: new Date(now()).toISOString(),
    })),
  };
}
