import { useState } from 'react';
import type { RefGrammar } from '../../blocker-refs';
import type { ItemBlockers, Relation } from '../../types';
import { BlockerAddRow } from '@/components/BlockerAddRow';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import type { RelationChoice } from '@/lib/relation-groups';

const NONE: ItemBlockers = { blockedBy: [], blocking: [] };

export interface RelationAddRowProps {
  source: string; itemId: string; selfId: string; relations: readonly Relation[]; choices: readonly RelationChoice[]; isBusy: boolean;
  grammar?: RefGrammar; onAdd(choice: RelationChoice, ref: string): void; onCancel(): void;
}

/** The relations section's add row (#829): one choice picks a type and a direction by its phrase, then the blocker add row's field and its
 * suggestions (findBlockers, at most 8). The issues already related under the choice are left out, since adding them is a no-op. */
export function RelationAddRow({ source, itemId, selfId, relations, choices, isBusy, grammar, onAdd, onCancel }: RelationAddRowProps) {
  const [index, setIndex] = useState(0);
  const choice = choices[index];
  const taken = relations.filter((r) => r.type === choice?.type && r.direction === choice.direction).map((r) => r.id);
  return (
    <BlockerAddRow
      source={source} itemId={itemId} selfId={selfId} blockers={NONE} taken={taken} isBusy={isBusy} grammar={grammar}
      picker={(closeOnEscape) => (
        <Select value={String(index)} disabled={isBusy} onValueChange={(v) => setIndex(Number(v))}>
          <SelectTrigger size="sm" aria-label={t('relations.type')} className="h-6 shrink-0 gap-1 px-1.5 text-xs" onKeyDown={closeOnEscape}><SelectValue /></SelectTrigger>
          <SelectContent>{choices.map((c, i) => <SelectItem key={`${c.direction}:${c.type}`} value={String(i)}>{c.phrase}</SelectItem>)}</SelectContent>
        </Select>
      )}
      onAdd={(_kind, ref) => { if (choice !== undefined) onAdd(choice, ref); }} onCancel={onCancel}
    />
  );
}
