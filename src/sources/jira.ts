import type { JiraCredential } from '../credentials.js';
import type { Logger } from '../log.js';
import type { ReadModel } from '../read-model/db.js';
import { SourceNotConnectedError } from '../source-errors.js';
import type { Citation } from '../tasks.js';
import type { ItemAction, Source, SourceItem, SourceItemRead, TaskComment } from '../types.js';
import { JiraNotFoundError } from './jira-fetch.js';
import { jiraItemOf } from './jira-item.js';
import { isListed, type JiraSourceConfig, listedTasks, projectOf, taskOf } from './jira-listing.js';
import { type JiraCall, postTransition, readComments, readIssue, readMyself, readStatuses, readTransitions } from './jira-queries.js';
import { writeIssue } from './jira-sync.js';

export type { JiraSourceConfig } from './jira-listing.js';

const FORMER_USER = 'Former user'; // what Jira itself shows for a deleted account

/** What a Jira adapter is built from (#820): the site's call, its stored login, the name writer and the read model 5.6 fills. */
export interface JiraAdapterDeps {
  call: JiraCall;
  credential(): Promise<JiraCredential | undefined>;
  renewName(name: string): Promise<void>;
  log?: Pick<Logger, 'warn'>;
  items?: { db: Pick<ReadModel, 'items' | 'transaction'> }; // absent (headless, setup mode): nothing is listed
}

export function createJiraSource(source: JiraSourceConfig, cited: Citation[], deps: JiraAdapterDeps): Source {
  const { call } = deps;
  const db = deps.items?.db;
  const columns = new Set(cited.map((c) => c.column));
  const rowsOf = (cred: JiraCredential): string => `jira:${source.site}:${cred.accountId}`; // the key #819's sync writes under

  async function account(): Promise<JiraCredential> {
    const cred = await deps.credential();
    if (cred === undefined) throw new SourceNotConnectedError(`jira:${source.site}`);
    return cred;
  }

  // One issue read live, stored as a write only when it is in the source's project: its scope would otherwise put it into this listing
  async function readTask(cred: JiraCredential, itemId: string): Promise<{ task: SourceItem; isOwn: boolean }> {
    const read = await readIssue(call, itemId);
    const rows = jiraItemOf(rowsOf(cred), source.project, read.issue, read.names, read.schema);
    const isOwn = projectOf(read.issue) === source.project;
    if (isOwn && db !== undefined) db.transaction(() => writeIssue(db, rows, 'write'));
    return { task: taskOf(rows, source), isOwn };
  }

  async function resolveFields(): Promise<void> {
    const cred = await account();
    const names = (await readStatuses(call, source.project)).map((s) => s.name);
    const missing = cited.find((c) => !names.includes(c.column));
    if (missing !== undefined) throw new Error(`"${missing.column}" is not a status of ${source.project}: ${names.join(', ')}`);
    // checked in the same answer, so a wrong name shows as the source's sync error before any stage closes
    if (!names.includes(source.doneStatus)) throw new Error(`"${source.doneStatus}" is not a status of ${source.project}: ${names.join(', ')}`);
    const me = await readMyself(call);
    // another account is reconnecting's business: the store key hangs on the account id, so only the name of this one is renewed
    if (me.accountId === cred.accountId && me.displayName !== undefined && me.displayName !== cred.displayName) {
      // best effort: the name only caches @me, so a credentials write that fails must not mark valid statuses as a broken source
      await deps.renewName(me.displayName).catch((err: unknown) => deps.log?.warn(`jira:${source.site}: display name not renewed (${err instanceof Error ? err.message : String(err)})`));
    }
  }

  async function listItems(): Promise<SourceItem[]> {
    const cred = await account();
    if (db === undefined) return [];
    return listedTasks(db.items, rowsOf(cred), source, columns).filter((task) => isListed(task, source, columns, cred.displayName));
  }

  // #191: boot hydrates every stored task and must never reject; the first poll applies the filter
  async function stored(): Promise<SourceItem[]> {
    const cred = await deps.credential();
    return cred === undefined || db === undefined ? [] : listedTasks(db.items, rowsOf(cred), source, columns);
  }

  // #567: in Jira, done is a status like any other, so closed is never answered
  async function item(itemId: string): Promise<SourceItemRead> {
    const cred = await account();
    try {
      const { task, isOwn } = await readTask(cred, itemId);
      if (!isOwn) return { reason: 'project', item: task.item };
      return { reason: isListed(task, source, columns, cred.displayName) ? 'listing' : 'filter', entry: task };
    } catch (err) {
      if (err instanceof JiraNotFoundError) return { reason: 'gone' };
      throw err;
    }
  }

  // The live read decides, since a stale row could skip a needed move; the re-read keeps a poll read before the move from moving it back
  async function setColumn(itemId: string, column: string): Promise<void> {
    const cred = await account();
    const before = await readTask(cred, itemId);
    if (before.task.column === column) return;
    const transition = (await readTransitions(call, itemId)).find((t) => t.to === column);
    if (transition === undefined) throw new Error(`${before.task.item.id}: no transition to "${column}"`);
    await postTransition(call, itemId, transition.id);
    await readTask(cred, itemId);
  }

  // The key the comment links need: the stored row's, else one live read, since the adapter is handed the issue id
  async function keyOf(cred: JiraCredential, itemId: string): Promise<string> {
    const row = db?.items.items(rowsOf(cred), [itemId])[0];
    return row?.item.key ?? (await readIssue(call, itemId)).issue.key ?? itemId;
  }

  // Read live each time the panel opens, never stored; oldest first, as Jira answers them
  async function comments(itemId: string): Promise<TaskComment[]> {
    const cred = await account();
    const key = await keyOf(cred, itemId);
    return (await readComments(call, itemId)).map((c) => ({
      author: c.author ?? FORMER_USER, createdAt: c.created, body: c.body,
      url: `https://${source.site}/browse/${key}?focusedCommentId=${encodeURIComponent(c.id)}`,
    }));
  }

  // SOURCE_ACTIONS.jira is move alone; 5.5 adds close, delete and archive
  async function apply(_itemId: string, action: ItemAction): Promise<void> {
    throw new Error(`"${action.type}" is not an action of a jira source`);
  }

  async function settingsOptions(): Promise<string[]> {
    return (await readStatuses(call, source.project)).map((s) => s.name);
  }

  return { resolveFields, listItems, stored, item, setColumn, apply, settingsOptions, comments };
}
