import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { itemSource } from '../../tasks';
import type { FieldValue, ItemField, ProjectItem } from '../../types';
import { readQuotaJson } from '@/hooks/use-project';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

/** What a field write answers (#686): the item's fields and its native view row, both re-read from the source after the write. */
export interface FieldAnswer { fields: ItemField[]; row: ProjectItem }

/** An item's fields route (#686): the source is the namespaced item id's prefix. */
export const fieldsPath = (itemId: string): string =>
  `/sources/${encodeURIComponent(itemSource(itemId) ?? '')}/items/${encodeURIComponent(itemId)}/fields`;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** An item's fields (#686); an answer without them reads as none. A 429 is the quota copy, as the native view's read. */
export async function readFields(itemId: string): Promise<ItemField[] | undefined> {
  const body = await readQuotaJson<{ fields?: unknown }>(fieldsPath(itemId));
  return Array.isArray(body.fields) ? (body.fields as ItemField[]) : undefined;
}

// What a failed write still carries (#686): the item as the source has it now, when a write failed midway and the route could re-read it
function resyncOf(err: unknown): FieldAnswer | undefined {
  const body = (err as { body?: { fields?: unknown; row?: unknown } } | null)?.body;
  return Array.isArray(body?.fields) && typeof body?.row === 'object' && body.row !== null ? { fields: body.fields as ItemField[], row: body.row as ProjectItem } : undefined;
}

/** One field write (#686): the answer, after a toast naming the field with the source's words when it failed. A write that failed midway
 * answers the item's re-read all the same, so the caller shows what the source has; any other failure answers undefined. */
export async function writeField(itemId: string, field: string, value: FieldValue): Promise<FieldAnswer | undefined> {
  try {
    return await postJson<FieldAnswer>(fieldsPath(itemId), { field, value });
  } catch (err) {
    toast.error(t('field.failed', { field, error: message(err) }));
    return resyncOf(err);
  }
}

/** The issue page's fields (#686): read when the item changes, replaced by a write's answer; none for no item, or while the read runs. An
 * answer replaces them only while its item is the one shown: a write of the item left behind answering late is dropped. */
export function useItemFields(itemId: string | undefined): { fields?: ItemField[]; replace(forItem: string, fields: ItemField[]): void } {
  const [shown, setShown] = useState<{ itemId: string; fields: ItemField[] }>();
  useEffect(() => {
    setShown(undefined);
    if (itemId === undefined) return;
    let isCurrent = true; // an item switched while a read ran drops its answer
    readFields(itemId).then(
      (read) => { if (isCurrent && read !== undefined) setShown({ itemId, fields: read }); },
      (err: unknown) => { if (isCurrent) toast.error(message(err)); },
    );
    return () => { isCurrent = false; };
  }, [itemId]);
  const replace = (forItem: string, fields: ItemField[]): void => setShown((current) => (current?.itemId === forItem ? { itemId: forItem, fields } : current));
  return { fields: shown !== undefined && shown.itemId === itemId ? shown.fields : undefined, replace };
}
