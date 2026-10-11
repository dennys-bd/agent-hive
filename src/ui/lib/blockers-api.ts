import type { BlockerChange, ItemBlockers } from '../../types.js';
import { postJson } from './api.js'; // relative: the root tsc compiles this file too

/** An item's blockers route (#56): `hive` for a task created in the Hive (item `local:<n>`), else the item's source. */
export const blockersPath = (source: string, itemId: string): string =>
  `/sources/${encodeURIComponent(source)}/items/${encodeURIComponent(itemId)}/blockers`;

/** One relation added or removed (#56), resolving to the item's relations after it. A refusal rejects with parseJson's error, its `code` the
 * route's (`blockers.*`): the caller maps it to its copy (#57), so nothing is shown here. */
export async function editBlocker(source: string, itemId: string, change: BlockerChange): Promise<ItemBlockers> {
  return (await postJson<{ blockers: ItemBlockers }>(blockersPath(source, itemId), change)).blockers;
}
