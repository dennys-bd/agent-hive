import type { LinkType, Relation, RelationChange } from '../../types.js';

export interface RelationGroup { phrase: string; relations: Relation[] }
/** The relations under each phrase as the site names it (#829), in the order of each phrase's first relation. No phrase or type is written
 * here, so a custom type groups with no change. */
export function groupByPhrase(relations: readonly Relation[]): RelationGroup[] {
  return [...new Set(relations.map((r) => r.phrase))].map((phrase) => ({ phrase, relations: relations.filter((r) => r.phrase === phrase) }));
}

export interface RelationChoice { type: string; direction: RelationChange['direction']; phrase: string }
/** The add row's choices (#829): each type once per direction by its phrase, outward first. A type whose two phrases read the same (Relates)
 * is offered once, outward: both choices would read alike on the item. */
export function relationChoices(types: readonly LinkType[]): RelationChoice[] {
  return types.flatMap((type): RelationChoice[] => [
    { type: type.name, direction: 'outward', phrase: type.outward },
    ...(type.inward === type.outward ? [] : [{ type: type.name, direction: 'inward' as const, phrase: type.inward }]),
  ]);
}
