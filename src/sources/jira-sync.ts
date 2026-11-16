import type { ReadModel } from '../read-model/db.js';
import type { SourceField, SourceItem } from '../read-model/source-items.js';
import { fieldRowsOf, type JiraItemRows, jiraItemOf } from './jira-item.js';
import { type JiraCall, projectJql, readFields, readStatuses, SEARCH_EXPAND, SEARCH_FIELDS, searchIssues, sinceMinutes } from './jira-queries.js';

/** source is the reading account (jira:<site>:<accountId>), project the key and the store's scope. now fixes the window in tests. */
export interface JiraSyncDeps {
  call: JiraCall;
  db: Pick<ReadModel, 'items' | 'transaction'>;
  source: string;
  project: string;
  now?: () => number;
}
/** changed: an upsert wrote, an item was removed or the listing changed, so 5.6 knows whether to emit readModel. */
export interface JiraSyncResult { changed: boolean }

type Db = JiraSyncDeps['db'];
const KEY_NUMBER = /-(\d+)$/;
const keyNumber = (key: string): number => Number(KEY_NUMBER.exec(key)?.[1] ?? Number.MAX_SAFE_INTEGER);
const byKey = (a: SourceItem, b: SourceItem): number => keyNumber(a.key) - keyNumber(b.key) || Number(a.key > b.key) - Number(a.key < b.key);

// Every stored item whose scope is the project: an issue moved to another project keeps its row under that one's scope
function scopeItems(db: Db, source: string, project: string): SourceItem[] {
  const ids = [...db.items.listing(source, project), ...db.items.unlisted(source, project)];
  return db.items.items(source, ids).map((r) => r.item).filter((item) => item.scope === project);
}

// Rebuilt from the store, by key number, as every search's ORDER BY key: stable, and not moved by a Rank change that leaves updated alone
function writeListing(db: Db, source: string, project: string): boolean {
  const next = scopeItems(db, source, project).sort(byKey).map((item) => item.nodeId);
  if (JSON.stringify(next) === JSON.stringify(db.items.listing(source, project))) return false;
  db.items.setListing(source, project, next);
  return true;
}

// Values only when the upsert wrote: a page read before a write cannot undo it through the side table
function writeIssue(db: Db, { item, values }: JiraItemRows): boolean {
  if (!db.items.upsertItem(item, 'sync')) return false;
  db.items.setValues(item.source, item.nodeId, values);
  return true;
}

async function readFieldRows(call: JiraCall, project: string): Promise<SourceField[]> {
  const [fields, statuses] = await Promise.all([readFields(call), readStatuses(call, project)]);
  return fieldRowsOf(fields, statuses);
}

const latest = (rows: readonly JiraItemRows[], cursor: string | null): string | null =>
  rows.reduce((max, { item }) => (max === null || item.updatedAt > max ? item.updatedAt : max), cursor);

/** One round: every page read and mapped first, then one transaction, so any failure (a 429 among them) stores nothing and leaves the cursor. */
export async function syncProject({ call, db, source, project, now = Date.now }: JiraSyncDeps): Promise<JiraSyncResult> {
  const cursor = db.items.cursor(source, project);
  const minutes = cursor === null ? undefined : sinceMinutes(cursor, now());
  const jql = projectJql(project, minutes); // a bad key throws here, before any call
  const read = await searchIssues(call, jql, SEARCH_FIELDS, SEARCH_EXPAND);
  // fields and statuses rarely change: read on a first sync (or an unreadable cursor) and by the reconcile, never on a plain round
  const fields = minutes === undefined ? await readFieldRows(call, project) : undefined;
  const rows = read.issues.map((issue) => jiraItemOf(source, project, issue, read.names, read.schema));
  const changed = db.transaction(() => {
    const wrote = rows.map((r) => writeIssue(db, r)).includes(true); // map, not some: every row is written
    if (fields !== undefined) db.items.setFields(source, project, fields);
    const listed = writeListing(db, source, project);
    // an unreadable stored cursor is not a floor: the next good round replaces it
    const from = minutes === undefined ? null : cursor;
    const next = latest(rows, from);
    if (next !== null && next !== cursor) db.items.setCursor(source, project, next);
    return wrote || listed;
  });
  return { changed };
}
