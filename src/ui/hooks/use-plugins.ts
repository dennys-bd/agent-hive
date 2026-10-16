import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogueItem, ItemKind } from '../../types';
import type { MessageKey } from '@/i18n';
import { getJson, postJson } from '@/lib/api';
import { HIVE_ORIGIN, type PluginScreen } from '@/lib/plugins';

export interface NewItem { kind: ItemKind; name: string; origin: string } // origin: 'hive' or a workspace name
export interface Plugins {
  items?: CatalogueItem[]; // undefined until the first read answers
  hasFailed: boolean;
  screen: PluginScreen; open(screen: PluginScreen): void;
  query: string; setQuery(query: string): void;
  filter?: string; setFilter(workspace: string | undefined): void; // the list's; never kept (decision 12)
  isCreating: boolean; setCreating(isCreating: boolean): void;
  create(item: NewItem): Promise<MessageKey | undefined>; // undefined: created, opened, read again
}

const LIST: PluginScreen = { kind: 'list', section: 'skills' };
// A refusal's HTTP status as the copy the field shows (decision 22): the server's own words never reach the screen
const REFUSAL: Readonly<Record<number, MessageKey>> = { 400: 'plugins.new.badName', 404: 'plugins.new.unknownWorkspace', 409: 'plugins.new.taken' };
const statusOf = (err: unknown): number => (err instanceof Error && 'status' in err && typeof err.status === 'number' ? err.status : 0);

/** The plugins view's state (#313): the catalogue, read on entering the view and after each write it makes (decision 21: nothing else writes
 * items while it is open, so no polling), the open screen, the search, the list's workspace filter and the new-item field. */
export function usePlugins(isShown: boolean): Plugins {
  const [items, setItems] = useState<CatalogueItem[]>();
  const [hasFailed, setFailed] = useState(false);
  const [screen, setScreen] = useState<PluginScreen>(LIST);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>();
  const [isCreating, setCreating] = useState(false);
  const reads = useRef(0);
  // The filter belongs to one list (decision 12): another section's list starts unfiltered
  const open = useCallback((next: PluginScreen): void => {
    if (next.kind === 'list' && (screen.kind !== 'list' || screen.section !== next.section)) setFilter(undefined);
    setScreen(next);
  }, [screen]);
  // The server logs a failed read's detail (ITEMS_ERROR_MESSAGE); anything but a list is a failure too
  // A read that answers after a newer one would put back an older catalogue: only the latest read lands
  const load = useCallback(async (): Promise<void> => {
    const n = ++reads.current;
    const read = await getJson<unknown>('/api/items').catch(() => undefined);
    if (n !== reads.current) return;
    if (Array.isArray(read)) setItems(read as CatalogueItem[]);
    setFailed(!Array.isArray(read));
  }, []);
  useEffect(() => {
    if (isShown) void load();
    else setFilter(undefined); // never kept across a visit
  }, [isShown, load]);
  const create = useCallback(async ({ kind, name, origin }: NewItem): Promise<MessageKey | undefined> => {
    try {
      // decision 13: the Hive side sends no origin, as #315's route always took it
      const item = await postJson<CatalogueItem>('/api/items', origin === HIVE_ORIGIN ? { kind, name } : { kind, name, origin });
      setCreating(false);
      open({ kind: 'item', id: item.id });
      await load();
      return undefined;
    } catch (err) {
      return REFUSAL[statusOf(err)] ?? 'plugins.new.failed';
    }
  }, [load, open]);
  return { items, hasFailed, screen, open, query, setQuery, filter, setFilter, isCreating, setCreating, create };
}
