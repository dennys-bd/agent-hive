import type { Logger } from '../log.js';
import { blockingRows, normalizeItem, readListing, storeListing, type ItemStore, type ItemsRead, type ListingKey, type StoredListing } from '../read-model/items.js';
import { applyWriteAnswer } from '../read-model/write-answer.js';
import type { Gql, SourceItem } from '../types.js';
import { blockersOf } from './github-blockers.js';
import { issueRepo, PROBE, relationsQuery, type GhIssueRelations, type GhItemNode, type GhRateLimit, type ProbeData, type RelationsData } from './github-queries.js';

/** A full read at least this often, whatever the probe says (#190): a blocker or a sub-issue off the Project does not move the probe. */
export const FULL_READ_MAX_AGE_MS = 15 * 60_000;

/** Relations by project item id: null, the issue was read and is gone; undefined, none stored. */
export type Relations = ReadonlyMap<string, GhIssueRelations | null | undefined>;

/** The probe (#190): the project's updatedAt, and the rateLimit the quota reading takes. A null owner or project throws `notFound`, as
 * pageItems does, so a gone source fails the poll instead of serving stale items. */
export async function readProbe(gql: Gql, variables: { login: string; number: number }, notFound: string): Promise<{ updatedAt: string; rateLimit: GhRateLimit | null | undefined }> {
  const data = (await gql(PROBE, variables)) as ProbeData;
  const updatedAt = data.repositoryOwner?.projectV2?.updatedAt;
  if (updatedAt === undefined) throw new Error(notFound);
  return { updatedAt, rateLimit: data.rateLimit };
}

// Issue dependencies and sub-issues that are still OPEN, in response order, without duplicates.
function openBlockers(issue: GhIssueRelations | null | undefined): string[] {
  if (!issue) return [];
  const nodes = [...(issue.blockedBy?.nodes ?? []), ...(issue.subIssues?.nodes ?? [])];
  return [...new Set(nodes.filter((n) => n.state === 'OPEN').map((n) => String(n.number)))];
}

/** The relations query over the kept tasks (#441, #56), by project item id. relationsQuery aliases each task by its index, a task with no
 * issue url skipped, so `i<index>` finds its answer. A failed query rejects: never "no blockers". */
export async function fetchRelations(gql: Gql, tasks: SourceItem[]): Promise<Map<string, GhIssueRelations | null>> {
  const query = relationsQuery(tasks.map((task) => task.item));
  if (!query) return new Map();
  const data = (await gql(query)) as RelationsData;
  return new Map(tasks.flatMap((task, i): [string, GhIssueRelations | null][] => (issueRepo(task.item.url) ? [[task.item.itemId, data[`i${i}`]?.issue ?? null]] : [])));
}

/** Every task with its relations (#441, #56): blockedBy when an open issue blocks it; a task whose issue was read also gets its blocker
 * relations both ways, empty lists included, so "none" and "not read" differ. Pure: the relations come fetched or stored. */
export function applyRelations(tasks: SourceItem[], relations: Relations): SourceItem[] {
  return tasks.map((task) => {
    const issue = relations.get(task.item.itemId);
    const blockedBy = openBlockers(issue);
    const repo = issueRepo(task.item.url);
    const blockers = issue && repo ? { blockers: blockersOf(issue, `${repo.owner}/${repo.name}`) } : {};
    return { ...task, item: { ...task.item, ...(blockedBy.length > 0 ? { blockedBy } : {}), ...blockers } };
  });
}

/** #282: the relations query's answer (blocking alone) joined with what the item's own read carries, its blockedBy and its sub-issues: what
 * applyRelations reads. Not read (undefined) and gone (null) pass through, so an item whose issue is gone gets no blockers. A sub-issue
 * without a number gates nothing: it has no id to name. */
export function joinRelations(nodes: GhItemNode[], answered: Relations): Map<string, GhIssueRelations | null | undefined> {
  return new Map(nodes.map((node): [string, GhIssueRelations | null | undefined] => {
    const issue = answered.get(node.id);
    if (!issue) return [node.id, issue];
    const c = node.content;
    const subIssues = (c?.subIssues?.nodes ?? []).flatMap((s) => (s.number === undefined ? [] : [{ number: s.number, state: s.state }]));
    return [node.id, { blockedBy: c?.blockedBy ?? { nodes: [] }, blocking: issue.blocking ?? { nodes: [] }, subIssues: { nodes: subIssues } }];
  }));
}

/** What the sync needs of the adapter (#190): its closure pieces, so the GitHub details stay there. */
export interface ItemsSyncDeps {
  store: ItemStore;
  probe(): Promise<string>; // the project's updatedAt; throws when the project is gone
  listNodes(): Promise<ItemsRead>; // a full read: the Project's fields and items
  kept(nodes: GhItemNode[]): SourceItem[]; // the poll's steps before the relations: what the relations query asks
  fetchRelations(tasks: SourceItem[]): Promise<Map<string, GhIssueRelations | null>>;
  log?: Logger;
  now?: () => number;
}

export interface ItemsSync {
  /** A poll's read: the probe, then a full read only when it moved, the stamp was cleared, the key changed or FULL_READ_MAX_AGE_MS passed; the
   * listing read back from the model either way. */
  list(key: ListingKey): Promise<StoredListing>;
  /** The tab's refresh (#282): the stamp cleared, then list, so the full read runs now. */
  refresh(key: ListingKey): Promise<StoredListing>;
  /** The kept tasks of a read back with their relations, joined with each node's own: the stored answers as they are, the missing ones fetched and stored. */
  relate(source: string, tasks: SourceItem[], read: StoredListing): Promise<SourceItem[]>;
  /** A write's re-read item stored with origin write, with the relations its entry read; a failure is logged, never thrown. */
  answer(node: GhItemNode, relations: ReadonlyMap<string, GhIssueRelations | null>, project: string): Promise<void>;
  /** Every adapter write: the next poll reads in full, since a relation write does not move the probe. */
  clear(): void;
}

function storeBlocking(store: ItemStore, source: string, relations: ReadonlyMap<string, GhIssueRelations | null>): void {
  store.db.transaction(() => {
    for (const [id, issue] of relations) store.db.setBlocking(source, id, blockingRows(issue));
  });
}

async function relateTasks(deps: ItemsSyncDeps, source: string, tasks: SourceItem[], read: StoredListing): Promise<SourceItem[]> {
  const fetched = await deps.fetchRelations(tasks.filter((task) => read.relations.get(task.item.itemId) === undefined));
  storeBlocking(deps.store, source, fetched);
  return applyRelations(tasks, joinRelations(read.nodes, new Map([...read.relations, ...fetched])));
}

async function storeAnswer(deps: ItemsSyncDeps, node: GhItemNode, relations: ReadonlyMap<string, GhIssueRelations | null>, project: string): Promise<void> {
  try {
    const source = await deps.store.source();
    if (source === undefined) return;
    applyWriteAnswer(deps.store, node.content?.repository?.nameWithOwner ?? '', { items: [normalizeItem(source, project, node)] });
    storeBlocking(deps.store, source, relations);
  } catch (err) {
    deps.log?.error(`source ${project}: a write's answer was not stored in the read model: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// In memory only (#190): a restart or a new adapter pays one full read
export function createItemsSync(deps: ItemsSyncDeps): ItemsSync {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  let stamp: string | undefined; // the probe read before the last full read: a change made during that read moves the next probe
  let readAt = 0;
  let readKey: string | undefined; // the listing the last full read stored: another one (a new login, another Project) has nothing stored yet
  let writes = 0; // clear() calls: a full read in flight when a write clears the stamp must not set it back
  let refreshing: Promise<StoredListing> | undefined;
  const clear = (): void => {
    writes += 1;
    stamp = undefined;
  };
  async function list(key: ListingKey): Promise<StoredListing> {
    const probed = await deps.probe();
    const keyed = `${key.source} ${key.project}`;
    if (probed !== stamp || keyed !== readKey || now() - readAt >= FULL_READ_MAX_AGE_MS) {
      const before = writes;
      const read = await deps.listNodes();
      const relations = await deps.fetchRelations(deps.kept(read.nodes)); // before the transaction: a failed query stores nothing
      storeListing(store.db, key, read, relations);
      stamp = writes === before ? probed : undefined;
      readAt = now();
      readKey = keyed;
    }
    return readListing(store.db, key); // one synchronous read: no write's upsert lands between it and the poll's dispatch
  }
  return {
    list,
    // one full read in flight at most: ?fresh=1 is not throttled, so concurrent ones share the running read
    refresh: (key) => {
      clear();
      if (refreshing === undefined) refreshing = list(key).finally(() => { refreshing = undefined; });
      return refreshing;
    },
    relate: (source, tasks, read) => relateTasks(deps, source, tasks, read),
    answer: (node, relations, project) => storeAnswer(deps, node, relations, project),
    clear,
  };
}
