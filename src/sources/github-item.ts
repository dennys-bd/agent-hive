import { ItemNotOnSourceError } from '../field-values.js';
import type { ItemStore } from '../read-model/items.js';
import type { Gql, Item, SourceItemRead, SourceItem } from '../types.js';
import { readItem } from './github-fields.js';
import { ISSUE_BY_NUMBER, issueRef, type GhItemFieldsNode, type IssueByNumberData, type IssueRef } from './github-queries.js';
import { statusOf } from './github-tree.js';

/** What one item's read needs of the adapter (#567): its transport and project, the poll's steps on one node, unfiltered and in any Status
 * option, the source's own filtering judged apart, and the read model when there is one. */
export interface ItemReadContext {
  gql: Gql; projectId: string;
  entry(node: GhItemFieldsNode): Promise<SourceItem | undefined>; // undefined only for a node with no Status value
  isListed(node: GhItemFieldsNode, entry: SourceItem): boolean;
  store?: ItemStore;
}

const GONE: SourceItemRead = { reason: 'gone' };
type IssueFields = Pick<Item, 'id' | 'title' | 'body' | 'url' | 'createdAt'>;
const createdAt = (at: string | undefined): Pick<Item, 'createdAt'> => (typeof at === 'string' ? { createdAt: at } : {});

// The caller matches the answer to its task by itemId; the issue alone carries no tree, facets, blockers or task props. A column only for a
// closed item still on the Project
const issueRead = (itemId: string, isClosed: boolean, fields: IssueFields, column?: string): SourceItemRead =>
  (isClosed ? { reason: 'closed', item: { itemId, ...fields }, ...(column === undefined ? {} : { column }) } : { reason: 'project', item: { itemId, ...fields } });

// Off the Project is a null node or another project's: readItem refuses both alike
async function projectNode(ctx: ItemReadContext, itemId: string): Promise<GhItemFieldsNode | undefined> {
  try {
    return await readItem(ctx.gql, itemId, ctx.projectId);
  } catch (err) {
    if (err instanceof ItemNotOnSourceError) return undefined;
    throw err;
  }
}

// The refetch stores the issue as an issue page's does, and its row answers; the cooldown's row is fresh enough for a poll. failed rejects,
// so 1.5 leaves the task as it was, as after a failed poll
async function modelIssue(store: ItemStore, rows: string, itemId: string, url: string, ref: IssueRef): Promise<SourceItemRead> {
  const repository = `${ref.owner}/${ref.name}`;
  const outcome = await store.refetch(repository, ref.number);
  if (outcome === 'failed') throw new Error(`issue ${repository}#${ref.number} could not be read`);
  const row = outcome === 'gone' ? undefined : store.db.issue(rows, repository, ref.number);
  if (row === undefined) return GONE;
  return issueRead(itemId, row.state === 'closed', { id: String(row.number), title: row.title, body: row.body, url, createdAt: row.createdAt });
}

// No read model (headless, most tests) or no login to read it under: one call, as the refetch costs
async function wireIssue(gql: Gql, itemId: string, ref: IssueRef): Promise<SourceItemRead> {
  const issue = ((await gql(ISSUE_BY_NUMBER, { owner: ref.owner, name: ref.name, number: ref.number })) as IssueByNumberData).repository?.issue;
  if (!issue) return GONE;
  return issueRead(itemId, issue.state === 'CLOSED', { id: String(issue.number), title: issue.title, body: issue.body ?? '', url: issue.url, ...createdAt(issue.createdAt) });
}

// Past the Project the item id names nothing: the task's url is what still reaches the issue
async function offProject(ctx: ItemReadContext, itemId: string, url: string): Promise<SourceItemRead> {
  const ref = issueRef(url);
  if (ref === undefined) return GONE;
  const rows = await ctx.store?.source();
  return ctx.store !== undefined && rows !== undefined ? modelIssue(ctx.store, rows, itemId, url, ref) : wireIssue(ctx.gql, itemId, ref);
}

/** #567: one item read past the listing, never a listing. On the Project: closed first, whatever the filter says, else the poll's entry and
 * whether the source's own filtering keeps it. Off it: the issue alone. Rejects when a read fails. */
export async function readOneItem(ctx: ItemReadContext, itemId: string, url: string): Promise<SourceItemRead> {
  const node = await projectNode(ctx, itemId);
  if (node === undefined) return offProject(ctx, itemId, url);
  const c = node.content;
  if (c?.__typename !== 'Issue' || typeof c.number !== 'number' || !c.url) return GONE;
  const fields = { id: String(c.number), title: c.title ?? `#${c.number}`, body: c.body ?? '', url: c.url, ...createdAt(c.createdAt) };
  if (c.state === 'CLOSED') return issueRead(itemId, true, fields, statusOf(node));
  const entry = await ctx.entry(node);
  if (entry === undefined) return issueRead(itemId, false, fields); // no Status value: no column to answer
  return { reason: ctx.isListed(node, entry) ? 'listing' : 'filter', entry };
}
