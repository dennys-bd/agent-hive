import type { JiraCredential } from '../credentials.js';
import type { Logger } from '../log.js';
import type { ReadModel } from '../read-model/db.js';
import { SourceNotConnectedError } from '../source-errors.js';
import type { Citation } from '../tasks.js';
import type { FieldValue, FieldWrite, ItemAction, ItemField, Source, SourceItem, SourceItemRead, TaskComment } from '../types.js';
import { archiveIssue, deleteIssue, subtaskIds } from './jira-actions.js';
import { JiraNotFoundError } from './jira-fetch.js';
import { type JiraFieldsContext, jiraFieldsOf, jiraSetField } from './jira-fields.js';
import { type JiraItemRows, jiraItemOf } from './jira-item.js';
import { isFiltered, isListed, type JiraSourceConfig, listedTasks, projectOf, storedLabels, taskOf } from './jira-listing.js';
import { type JiraCall, type JiraFieldMeta, type JiraIssue, postTransition, readComments, readIssue, readMyself, readStatuses, readTransitions } from './jira-queries.js';
import { writeIssue } from './jira-sync.js';
import { inPlace, isHidden, treeLinks, withTree } from './jira-tree.js';

export type { JiraSourceConfig } from './jira-listing.js';

const FORMER_USER = 'Former user'; // what Jira itself shows for a deleted account

/** What a Jira adapter is built from (#820): the site's call, its stored login, the name writer and the read model 5.6 fills. */
export interface JiraAdapterDeps {
  call: JiraCall;
  agile: JiraCall; // #826: the Agile API's call, for the sprints, bound as call is
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

  // One issue's read stored as a write only when it is in the source's project: its scope would otherwise put it into this listing
  function keep(cred: JiraCredential, read: JiraFieldMeta & { issue: JiraIssue }): { rows: JiraItemRows; task: SourceItem; isOwn: boolean } {
    const rows = jiraItemOf(rowsOf(cred), source.project, read.issue, read.names, read.schema);
    const isOwn = projectOf(read.issue) === source.project;
    if (isOwn && db !== undefined) db.transaction(() => writeIssue(db, rows, 'write'));
    // #830: its tree read over the stored listing with the issue in its place, so a single read's links equal the next listing's
    const listing = !isOwn || db === undefined ? [] : db.items.items(rowsOf(cred), db.items.listing(rowsOf(cred), source.project));
    const links = treeLinks(inPlace(listing, rows), source.tree);
    return { rows, task: withTree(taskOf(rows, source), links.get(rows.item.nodeId), source), isOwn };
  }

  async function readTask(cred: JiraCredential, itemId: string): Promise<{ task: SourceItem; isOwn: boolean }> {
    const { task, isOwn } = keep(cred, await readIssue(call, itemId));
    return { task, isOwn };
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
      // a parent epics: hide takes off is judged as filtered, as on GitHub: it keeps its entry
      return { reason: isListed(task, source, columns, cred.displayName) && !isHidden(task, source) ? 'listing' : 'filter', entry: task };
    } catch (err) {
      if (err instanceof JiraNotFoundError) return { reason: 'gone' };
      throw err;
    }
  }

  // The live read decides, since a stale row could skip a needed move; the re-read keeps a poll read before the move from moving it back
  async function moveTo(itemId: string, status: string): Promise<void> {
    const cred = await account();
    const before = await readTask(cred, itemId);
    if (before.task.column === status) return;
    const transition = (await readTransitions(call, itemId)).find((t) => t.to === status);
    if (transition === undefined) throw new Error(`${before.task.item.id}: no transition to "${status}"`);
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

  // The rows go with the issue: neither a deleted nor an archived one shows in the incremental sync, so the next poll would list it again.
  // One Jira no longer has is already off it: its row goes, else the action would fail on every try until the daily reconcile
  async function leave(itemId: string, type: 'delete' | 'archive'): Promise<void> {
    const cred = await account();
    const drop = (ids: string[]): void => db?.items.removeItems(rowsOf(cred), ids);
    const read = await readIssue(call, itemId).catch((err: unknown) => {
      if (err instanceof JiraNotFoundError) return undefined;
      throw err;
    });
    if (read === undefined) return drop([itemId]);
    const { issue } = read; // the subtask ids before the write, which takes them with it
    const id = issue.id ?? itemId; // the row's node id, even when the caller named the key
    await (type === 'delete' ? deleteIssue(call, id) : archiveIssue(call, id, issue.key ?? id));
    drop([id, ...subtaskIds(issue)]);
  }

  // url is not read: the issue id reaches any project. A close reason has no Jira counterpart, so every close is the move to doneStatus
  async function apply(itemId: string, action: ItemAction): Promise<void> {
    if (action.type === 'close') return moveTo(itemId, source.doneStatus);
    if (action.type === 'delete' || action.type === 'archive') return leave(itemId, action.type);
    throw new Error(`"${action.type}" is not an action of a jira source`); // remove: Jira has no Project to take an item off
  }

  async function settingsOptions(): Promise<string[]> {
    return (await readStatuses(call, source.project)).map((s) => s.name);
  }

  // #826: what the field reads and writes run on, under the account that reads them
  async function fieldsContext(): Promise<JiraFieldsContext> {
    const cred = await account();
    const me = cred.displayName;
    return {
      call, agile: deps.agile, source, keep: (read) => keep(cred, read), setColumn: moveTo,
      labels: () => (db === undefined ? [] : storedLabels(db.items, rowsOf(cred), source.project)),
      isListed: (task) => isListed(task, source, columns, me) && !isHidden(task, source), isFiltered: (task) => isFiltered(task, source, me),
    };
  }

  // #826: every read is live, so ReadOptions.fresh has nothing to add
  const fieldsOf = async (itemId: string): Promise<ItemField[]> => jiraFieldsOf(await fieldsContext(), itemId);
  const setField = async (itemId: string, field: string, value: FieldValue): Promise<FieldWrite> => jiraSetField(await fieldsContext(), itemId, field, value);

  return { resolveFields, listItems, stored, item, setColumn: moveTo, apply, settingsOptions, comments, fieldsOf, setField };
}
