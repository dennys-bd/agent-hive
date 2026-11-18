import { BadBlockerRefError, BlockerRefNotFoundError, RelationRereadError, SelfBlockerError } from '../blocker-errors.js';
import { WireError } from '../read-model/normalize.js';
import type { JsonValue, SourceItems, StoredSourceItem } from '../read-model/source-items.js';
import type { BlockerChange, BlockerRef, BlockerWrite, ItemBlockers, SourceItem } from '../types.js';
import { JiraNotFoundError } from './jira-fetch.js';
import { type JiraLink, linksOf, statusCategoryOf } from './jira-item.js';
import { deleteIssueLink, type JiraCall, type JiraIssue, type JiraIssueRead, postIssueLink, readIssue, readLinkTypes, searchPage } from './jira-queries.js';
import { jiraRefs } from './jira-refs.js';

// Blockers from a Jira issue's links of the source's blocking types (#828): what a task shows and what gates its start. Link types that do not
// block (6.4) and remote links stay out

/** What a link list reads of a link: data.links' shape less linkId. A row stored before #828 has no linkId until its next sync; one stored
 * without a phrase (#829) reads its type's name, as linkOf stores it. */
export type BlockingLink = Pick<JiraLink, 'type' | 'direction' | 'phrase' | 'id' | 'key' | 'title' | 'statusCategory'>;
/** A linked issue's status category in the read model: undefined when the model has no row for it, null when its row has none. */
export type CategoryOf = (nodeId: string) => string | null | undefined;
/** No store to read: every blocker keeps its link's own category. */
export const NO_CATEGORIES: CategoryOf = () => undefined;

const DONE = 'done';
const FOUND_MAX = 8; // the add row's list (#57), as GitHub's
const FOUND_FIELDS: readonly string[] = ['summary', 'status'];
const DIRECTION = { blockedBy: 'inward', blocking: 'outward' } as const;
const NO_TYPE = 'no blocking link type is configured';

function linkAt(value: JsonValue): BlockingLink[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const { type, direction, phrase, id, key, title, statusCategory } = value;
  if (typeof type !== 'string' || (direction !== 'inward' && direction !== 'outward') || typeof id !== 'string' || typeof key !== 'string') return [];
  return [{
    type, direction, phrase: typeof phrase === 'string' ? phrase : type, id, key,
    title: typeof title === 'string' ? title : null, statusCategory: typeof statusCategory === 'string' ? statusCategory : null,
  }];
}

/** data.links as stored, read leniently: an entry of another shape is no link, never a refusal. */
export const storedLinks = (value: JsonValue | undefined): BlockingLink[] => (Array.isArray(value) ? value.flatMap(linkAt) : []);

/** Every issue the rows link to, each once: the ids one store read asks for. */
export const linkedIds = (rows: readonly Pick<StoredSourceItem, 'item'>[]): string[] =>
  [...new Set(rows.flatMap((r) => storedLinks(r.item.data.links).map((l) => l.id)))];

/** The linked issues' categories from one store read under `rows`. A blocker's own row is fresher than the link's snapshot: a blocker that
 * moves to done does not change the blocked issue's `updated`, so the link stays as it was synced. */
export function storedCategories(items: Pick<SourceItems, 'items'>, rows: string, ids: readonly string[]): CategoryOf {
  const found = new Map(items.items(rows, ids).map((s): [string, JsonValue | undefined] => [s.item.nodeId, s.item.data.statusCategory]));
  return (nodeId) => {
    if (!found.has(nodeId)) return undefined;
    const category = found.get(nodeId);
    return typeof category === 'string' ? category : null;
  };
}

// exported for the relations (#829): one state rule for both sections
export function stateOf(link: BlockingLink, categoryOf: CategoryOf): BlockerRef['state'] {
  const stored = categoryOf(link.id);
  return (stored === undefined ? link.statusCategory : stored) === DONE ? 'closed' : 'open';
}

/** An issue's blockers: its links of a blocking type (compared exactly, as Jira names it), inward ones blockedBy and outward ones blocking,
 * in Jira's order. A pair linked by two blocking types shows once per direction. */
export function blockersOf(links: readonly BlockingLink[], types: readonly string[], categoryOf: CategoryOf): ItemBlockers {
  const refs = (direction: BlockingLink['direction']): BlockerRef[] => links
    .filter((l) => l.direction === direction && types.includes(l.type))
    .filter((l, i, all) => all.findIndex((o) => o.id === l.id) === i)
    .map((l) => ({ id: l.key, title: l.title ?? '', state: stateOf(l, categoryOf) }));
  return { blockedBy: refs('inward'), blocking: refs('outward') };
}

/** The keys of the open blockers: Item.blockedBy, what gates the start and what a `blocked` rule reads. */
export const openBlockers = (blockers: ItemBlockers): string[] => blockers.blockedBy.filter((r) => r.state === 'open').map((r) => r.id);

/** What the writes read and write through (#828), built by the adapter per account: the module reads and writes links, the adapter maps a
 * read into its row and task (keep), so the two never disagree on what a task is. */
export interface RelationsContext {
  call: JiraCall;
  blockingTypes: readonly string[];
  categories(ids: readonly string[]): CategoryOf;
  keep(read: JiraIssueRead): { task: SourceItem; isListed: boolean }; // stored when in the project; isListed: listItems would list it
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
function required(value: string | undefined, what: string): string {
  if (value === undefined) throw new WireError(what);
  return value;
}
const blockersRead = (ctx: RelationsContext, links: readonly BlockingLink[]): ItemBlockers =>
  blockersOf(links, ctx.blockingTypes, ctx.categories(links.map((l) => l.id)));

// The type an added link takes: the first configured. With none, the add is refused before any call
function addedType(ctx: RelationsContext): string {
  const [type] = ctx.blockingTypes;
  if (type === undefined) throw new Error(NO_TYPE);
  return type;
}

// The issue a ref names (#828, #829): only a key reads, and a key Jira does not answer is a ref to nothing
export async function otherOf(ctx: RelationsContext, ref: string): Promise<JiraIssueRead> {
  const key = jiraRefs.refOf(ref);
  if (key === undefined) throw new BadBlockerRefError(ref, jiraRefs.forms);
  try {
    return await readIssue(ctx.call, key);
  } catch (err) {
    if (err instanceof JiraNotFoundError) throw new BlockerRefNotFoundError(ref);
    throw err;
  }
}

/** The other issue's id; the item itself is refused, whichever section asks (#828, #829). */
export function checkedOtherId(own: JiraIssueRead, other: JiraIssueRead): string {
  const otherId = required(other.issue.id, 'jira issue id');
  if (otherId === required(own.issue.id, 'jira issue id')) throw new SelfBlockerError();
  return otherId;
}

/** [inwardIssue, outwardIssue] for a link the item reads in `direction`: the outward phrase runs from inwardIssue to outwardIssue, so a link
 * the item reads outward names the item inwardIssue ("A blocks B" posts A as inwardIssue). */
export const endsOf = (direction: JiraLink['direction'], own: JiraIssueRead, other: JiraIssueRead): [string, string] => {
  const [from, to] = direction === 'outward' ? [own, other] : [other, own];
  return [required(from.issue.key, 'jira issue key'), required(to.issue.key, 'jira issue key')];
};

/** After a write (#828, #829): what `of` reads of the links now, then the entry when the task is listed. The write has landed, so a failure
 * throws `fail` with what was read so far. */
export async function afterWrite<T>(
  ctx: RelationsContext, itemId: string, of: (links: readonly JiraLink[]) => T, fail: (message: string, read: T | undefined) => Error,
): Promise<{ value: T; entry?: SourceItem }> {
  let value: T | undefined;
  try {
    const read = await readIssue(ctx.call, itemId);
    value = of(linksOf(read.issue));
    const { task, isListed } = ctx.keep(read);
    return { value, ...(isListed ? { entry: task } : {}) };
  } catch (err) {
    throw fail(errorMessage(err), value);
  }
}

/** One blocker added or removed on a Jira issue (#828), by its issue id, as GitHub's relateItem (#56). The relation already as asked sends
 * nothing and answers the relations read, so a double click is harmless. A removal deletes every blocking-type link to the other issue in
 * the asked direction, so the pair no longer blocks. */
export async function relate(ctx: RelationsContext, itemId: string, change: BlockerChange): Promise<BlockerWrite> {
  const type = change.action === 'add' ? addedType(ctx) : undefined;
  const own = await readIssue(ctx.call, itemId);
  const other = await otherOf(ctx, change.ref);
  const otherId = checkedOtherId(own, other);
  const links = linksOf(own.issue);
  const matches = links.filter((l) => l.id === otherId && l.direction === DIRECTION[change.kind] && ctx.blockingTypes.includes(l.type));
  if ((matches.length > 0) === (change.action === 'add')) return { blockers: blockersRead(ctx, links) };
  if (type === undefined) {
    for (const link of matches) await deleteIssueLink(ctx.call, link.linkId); // in turn: a retry deletes whatever a failure left
  } else {
    await postIssueLink(ctx.call, type, ...endsOf(DIRECTION[change.kind], own, other));
  }
  const { value, entry } = await afterWrite(ctx, itemId, (l) => blockersRead(ctx, l), (message, blockers) => new RelationRereadError(message, blockers));
  return { blockers: value, ...(entry === undefined ? {} : { entry }) };
}

/** A text as a JQL string's content: backslash and double quote escaped, so the text cannot close the string it is put in. */
export const jqlText = (text: string): string => text.replace(/[\\"]/g, '\\$&');

function foundRef(issue: JiraIssue): BlockerRef[] {
  if (issue.key === undefined) return [];
  const { summary } = issue.fields;
  return [{ id: issue.key, title: typeof summary === 'string' ? summary : '', state: statusCategoryOf(issue.fields) === DONE ? 'closed' : 'open' }];
}

/** The add row's suggestions (#828, #57): the source's project's issues whose summary matches the text, or whose key it is, open and closed,
 * newest first, at most 8, from one page. A blank text asks nothing. */
export async function findBlockers(ctx: { call: JiraCall; project: string }, text: string): Promise<BlockerRef[]> {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const key = jiraRefs.refOf(trimmed);
  const clauses = [`summary ~ "${jqlText(trimmed)}"`, ...(key === undefined ? [] : [`key = "${key}"`])];
  const jql = `project = "${ctx.project}" AND (${clauses.join(' OR ')}) ORDER BY updated DESC`;
  return (await searchPage(ctx.call, jql, FOUND_FIELDS, FOUND_MAX)).issues.flatMap(foundRef).slice(0, FOUND_MAX);
}

/** resolveFields' check (#828): the first configured blocking type the site lacks is refused, naming the site's types. */
export async function checkLinkTypes(call: JiraCall, site: string, types: readonly string[]): Promise<void> {
  const names = (await readLinkTypes(call)).map((t) => t.name);
  const missing = types.find((t) => !names.includes(t));
  if (missing !== undefined) throw new Error(`"${missing}" is not a link type of ${site}: ${names.join(', ')}`);
}
