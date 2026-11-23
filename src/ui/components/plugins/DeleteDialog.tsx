import { useState } from 'react';
import type { CatalogueItem } from '../../../types';
import { Confirm } from '@/components/Confirm';
import { type MessageKey, t, tPlural } from '@/i18n';
import { callersOf, childrenOf, kindLabel, originalLabel } from '@/lib/plugins';

export interface DeleteDialogProps {
  item: CatalogueItem; items: readonly CatalogueItem[]; version: string;
  isItem: boolean; // the item's last version: deleting it deletes the item (custom-store.ts's revert)
  onDelete(): Promise<MessageKey | undefined>; onClose(): void;
}

// #dlg-del-version: where each workspace on the version goes, then the versions made from it. Only a Hive item has workspaces here: a
// user-created version with any is refused before the dialog (deleteEntryOf)
function versionMessage(item: CatalogueItem, version: string): string[] {
  const workspaces = item.versions.find((v) => v.name === version)?.workspaces ?? [];
  const fallback = originalLabel(item);
  const kept = childrenOf(item, version);
  return [
    ...workspaces.map((workspace) => t('plugins.delete.workspace', { workspace, version, fallback })),
    ...(kept.length === 0 ? [] : [tPlural('plugins.delete.kept', kept.length, { names: kept.join(', '), version })]),
  ];
}

// #dlg-del-item: the item goes from every workspace, and the items that still call it, which the reviewer will flag
function itemMessage(item: CatalogueItem, items: readonly CatalogueItem[], version: string): string[] {
  const callers = callersOf(item, items);
  return [
    t('plugins.delete.lastVersion', { version, kind: kindLabel(item.kind) }),
    ...(callers.length === 0 ? [] : [tPlural('plugins.delete.callers', callers.length, { callers: callers.join(', '), name: item.name })]),
  ];
}

/** The versions menu's delete (#983): what happens, then that it cannot be undone. A refusal shows inline and keeps the dialog open. */
export function DeleteDialog({ item, items, version, isItem, onDelete, onClose }: DeleteDialogProps) {
  // Read once, on open: the catalogue read after the delete rewrites item.versions while the dialog closes
  const [message] = useState(() => [...(isItem ? itemMessage(item, items, version) : versionMessage(item, version)), t('plugins.delete.undone')].join(' '));
  const [refused, setRefused] = useState<MessageKey>();
  const confirm = async (): Promise<void> => {
    const refusal = await onDelete();
    if (refusal === undefined) return;
    setRefused(refusal);
    throw new Error(refusal); // keeps the dialog open (DialogBase)
  };
  return (
    <Confirm
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} danger onConfirm={confirm} confirmLabel={t('plugins.delete.confirm')} message={message}
      title={isItem ? t('plugins.delete.itemTitle', { name: item.name }) : t('plugins.delete.versionTitle', { version })}
      error={refused === undefined ? undefined : t(refused, { version })}
    />
  );
}
