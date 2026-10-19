// #353: the items each source closed through a leaving action, and when. A poll whose read began before an item closed may still list
// it, and mergeTasks would bring the closed task back as new (then `missing` on the next poll): that listing drops it instead. In memory
// only: a restart loses the record, and no poll is in flight after a boot.

export interface LeftItems {
  record(source: string, itemId: string, at: number): void;
  /** The listing without the items `source` closed at or after `startedAt`; records older than `startedAt` are forgotten. */
  filter<T extends { item: { itemId: string } }>(source: string, startedAt: number, listed: readonly T[]): T[];
}

export function createLeftItems(): LeftItems {
  const closed = new Map<string, Map<string, number>>();
  return {
    record(source, itemId, at) {
      closed.set(source, (closed.get(source) ?? new Map<string, number>()).set(itemId, at));
    },
    // ponytail: two overlapping polls of one source, the later-started answering first, forget the record and the earlier one brings the item back; a per-source in-flight guard would close it
    filter<T extends { item: { itemId: string } }>(source: string, startedAt: number, listed: readonly T[]): T[] {
      const records = closed.get(source);
      // A read that began after the close is the truth: an item it lists was restored on the source, so the record goes either way.
      // A tie stays: a read that starts in the close's millisecond may have begun before it
      for (const [itemId, at] of records ?? []) if (at < startedAt) records?.delete(itemId);
      return listed.filter(({ item }) => !records?.has(item.itemId));
    },
  };
}
