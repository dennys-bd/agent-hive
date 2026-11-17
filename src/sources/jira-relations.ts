import type { JsonValue, SourceItems, StoredSourceItem } from '../read-model/source-items.js';
import type { BlockerRef, ItemBlockers } from '../types.js';
import type { JiraLink } from './jira-item.js';

// Blockers from a Jira issue's links of the source's blocking types (#828): what a task shows and what gates its start. Link types that do not
// block (6.4) and remote links stay out

/** What a blocker list reads of a link: data.links' shape less linkId and phrase. A row stored before #828 has no linkId until its next sync. */
export type BlockingLink = Pick<JiraLink, 'type' | 'direction' | 'id' | 'key' | 'title' | 'statusCategory'>;
/** A linked issue's status category in the read model: undefined when the model has no row for it, null when its row has none. */
export type CategoryOf = (nodeId: string) => string | null | undefined;

const DONE = 'done';

function linkAt(value: JsonValue): BlockingLink[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const { type, direction, id, key, title, statusCategory } = value;
  if (typeof type !== 'string' || (direction !== 'inward' && direction !== 'outward') || typeof id !== 'string' || typeof key !== 'string') return [];
  return [{ type, direction, id, key, title: typeof title === 'string' ? title : null, statusCategory: typeof statusCategory === 'string' ? statusCategory : null }];
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

function stateOf(link: BlockingLink, categoryOf: CategoryOf): BlockerRef['state'] {
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
