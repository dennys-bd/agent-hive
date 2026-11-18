import type { LinkType, Relation, RelationChange } from '../../types.js';
import { getJson, postJson } from './api.js'; // relative: the root tsc compiles this file too

/** An item's relations route (#829). */
export const relationsPath = (source: string, itemId: string): string =>
  `/sources/${encodeURIComponent(source)}/items/${encodeURIComponent(itemId)}/relations`;

/** One relation added or removed (#829), resolving to the item's relations after it. A refusal rejects with parseJson's error and the route's
 * `blockers.*` code, as editBlocker's does, so blockerErrorText reads it. */
export async function editRelation(source: string, itemId: string, change: RelationChange): Promise<Relation[]> {
  return (await postJson<{ relations: Relation[] }>(relationsPath(source, itemId), change)).relations;
}

/** The types a relation may take (#829): the site's link types less the source's blocking ones, which the route leaves out. */
export async function readRelationTypes(source: string): Promise<LinkType[]> {
  return (await getJson<{ linkTypes: LinkType[] }>(`/sources/${encodeURIComponent(source)}/link-types?relations=1`)).linkTypes;
}
