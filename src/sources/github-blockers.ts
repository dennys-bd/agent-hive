import type { BlockerChange, BlockerRef, BlockerWrite, Gql, Item, ItemBlockers } from '../types.js';
import { readItem, reread, type FieldsContext } from './github-fields.js';
import {
  ADD_BLOCKED_BY, ISSUE_ID, issueRepo, relationsQuery, REMOVE_BLOCKED_BY, type GhBlockerRef, type GhIssueRelations, type IssueIdData, type RelationsData,
} from './github-queries.js';

// #56: the id the UI shows a related issue by: its number in the item's own repository, `owner/repo#n` in another. GitHub's casing of a name
// need not be the user's, so the repositories compare case-blind
const refId = (nameWithOwner: string, number: number, repo: string): string =>
  (nameWithOwner.toLowerCase() === repo.toLowerCase() ? String(number) : `${nameWithOwner}#${number}`);

const refsOf = (nodes: GhBlockerRef[] | undefined, repo: string): BlockerRef[] =>
  (nodes ?? []).map((n): BlockerRef => ({ id: refId(n.repository.nameWithOwner, n.number, repo), title: n.title, state: n.state === 'OPEN' ? 'open' : 'closed' }));

/** An issue's blocker relations as the UI shows them (#56), both directions. Sub-issues never: they gate a start, they are no relation.
 * `repo` is the item's own `owner/name`. */
export function blockersOf(issue: GhIssueRelations, repo: string): ItemBlockers {
  return { blockedBy: refsOf(issue.blockedBy?.nodes, repo), blocking: refsOf(issue.blocking?.nodes, repo) };
}

/** A ref that is none of `12`, `#12` or `owner/repo#12` (#56). */
export class BadBlockerRefError extends Error {
  constructor(ref: string) { super(`"${ref}" names no issue: write 12, #12 or owner/repo#12`); }
}
/** No issue answers the ref (#56). */
export class BlockerRefNotFoundError extends Error {
  constructor(ref: string) { super(`no issue ${ref}`); }
}
/** The ref is the item itself (#56). */
export class SelfBlockerError extends Error {
  constructor() { super('an issue cannot block itself'); }
}
/** The relation was written but its re-read failed (#56): the relations ride along when they were read, so the caller can still answer;
 * undefined when even they failed, since empty lists would show the relation just written as gone. */
export class RelationRereadError extends Error {
  constructor(message: string, readonly blockers?: ItemBlockers) { super(message); }
}

const NO_BLOCKERS: ItemBlockers = { blockedBy: [], blocking: [] };
// `12`, `#12` or `owner/repo#12`; the repository needs its `#`, so `acme/r12` is no ref. Nine digits stay inside GraphQL's Int
const REF = /^(?:([\w.-]+)\/([\w.-]+)#|#?)(\d{1,9})$/;

type IssueKey = { owner: string; name: string; number: number };

// The issue a ref names; a short one is in the item's own repository, as GitHub's own picker reads it
function parseRef(ref: string, own: { owner: string; name: string }): IssueKey {
  const match = REF.exec(ref.trim());
  if (!match) throw new BadBlockerRefError(ref);
  const [, owner, name, digits] = match;
  return owner === undefined || name === undefined ? { ...own, number: Number(digits) } : { owner, name, number: Number(digits) };
}

// The item's relations alone, through the poll's own relations query over a minimal item: a Project row with no task has no entry to read
// them from
async function readBlockers(gql: Gql, url: string, repo: string): Promise<ItemBlockers> {
  const item: Item = { itemId: '', id: '', title: '', body: '', url };
  const query = relationsQuery([item]);
  const issue = query === undefined ? undefined : ((await gql(query)) as RelationsData).i0?.issue;
  return issue ? blockersOf(issue, repo) : NO_BLOCKERS;
}

// GitHub answers a repository or issue that does not exist with an errors array ("Could not resolve to …"), which the gql call throws;
// that, like a null issue, is a ref to nothing
const NOT_FOUND = /Could not resolve to/;
async function issueIdOf(gql: Gql, target: IssueKey, ref: string): Promise<string> {
  let id: string | undefined;
  try {
    id = ((await gql(ISSUE_ID, target)) as IssueIdData).repository?.issue?.id;
  } catch (err) {
    if (err instanceof Error && NOT_FOUND.test(err.message)) throw new BlockerRefNotFoundError(ref);
    throw err;
  }
  if (id === undefined) throw new BlockerRefNotFoundError(ref);
  return id;
}

// After the mutation: the relations and the entry as they read now. The write has landed, so a failure carries what was read so far
async function afterWrite(ctx: FieldsContext, itemId: string, url: string, repo: string): Promise<BlockerWrite> {
  let blockers: ItemBlockers | undefined;
  try {
    blockers = await readBlockers(ctx.gql, url, repo);
    const { entry } = await reread(ctx, itemId);
    return { blockers, ...(entry === undefined ? {} : { entry }) };
  } catch (err) {
    throw new RelationRereadError(err instanceof Error ? err.message : String(err), blockers);
  }
}

/** One blocker relation added or removed on a GitHub item (#56), by its project item id. The ref resolves by ISSUE_ID; GitHub has only the
 * blocked-by pair, so `blocking` swaps the sides. A relation already as asked sends nothing and answers the relations read: a double click
 * is harmless. Then the relations and the entry are re-read, as a field write's. */
export async function relateItem(ctx: FieldsContext, itemId: string, change: BlockerChange): Promise<BlockerWrite> {
  const c = (await readItem(ctx.gql, itemId, ctx.projectId)).content;
  const own = issueRepo(c?.url ?? '');
  if (c?.__typename !== 'Issue' || c.id === undefined || c.url === undefined || own === undefined) throw new Error(`item ${itemId} is not an issue`);
  const repo = `${own.owner}/${own.name}`;
  const target = parseRef(change.ref, own);
  const otherId = await issueIdOf(ctx.gql, target, change.ref);
  if (otherId === c.id) throw new SelfBlockerError();
  const before = await readBlockers(ctx.gql, c.url, repo);
  const exists = before[change.kind].some((r) => r.id === refId(`${target.owner}/${target.name}`, target.number, repo));
  if (exists === (change.action === 'add')) return { blockers: before };
  const [issueId, blockingIssueId] = change.kind === 'blockedBy' ? [c.id, otherId] : [otherId, c.id];
  await ctx.gql(change.action === 'add' ? ADD_BLOCKED_BY : REMOVE_BLOCKED_BY, { issueId, blockingIssueId });
  return afterWrite(ctx, itemId, c.url, repo);
}
