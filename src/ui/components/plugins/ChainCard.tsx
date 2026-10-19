import { type KeyboardEvent, useRef, useState } from 'react';
import type { ChainSpec } from '../../../template-condition';
import type { EditResult } from '../../../template-edit';
import { ChainForm } from '@/components/plugins/ChainForm';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { emptyDraft, type FormVariable, specOf } from '@/lib/chain-draft';

export interface ChainCardProps { variables: readonly FormVariable[]; onInsert(spec: ChainSpec): EditResult; onClose(): void }

/** The "+"'s card in the map's flow (#322, handoff 11n): an empty chain's form, insert / cancel. Its draft lives and dies with it (decision 11). */
export function ChainCard({ variables, onInsert, onClose }: ChainCardProps) {
  const [draft, setDraft] = useState(emptyDraft);
  const [isRefused, setRefused] = useState(false);
  const host = useRef<HTMLElement>(null);
  const spec = specOf(draft, variables);
  // decision 20: from a "+" only an incomplete form could be refused, and insert is disabled for that; anything else is the generic copy
  const insert = (): void => {
    if (spec === null) return;
    if (onInsert(spec).ok) onClose();
    else setRefused(true);
  };
  // Esc inside the card only: a select's list is portalled, and its own Esc must close the list, not the card (decision 19)
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && event.target instanceof Node && host.current?.contains(event.target)) onClose();
  };
  return (
    <section ref={host} aria-label={t('plugins.chain.card')} onKeyDown={onKeyDown} className="my-1 flex flex-col gap-2 rounded-md border border-dashed p-2">
      <ChainForm draft={draft} variables={variables} onChange={(next) => { setDraft(next); setRefused(false); }} />
      {isRefused && <p role="alert" className="text-destructive text-xs">{t('plugins.chain.failed')}</p>}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>{t('plugins.chain.cancel')}</Button>
        <Button type="button" size="xs" disabled={spec === null} onClick={insert}>{t('plugins.chain.insert')}</Button>
      </div>
    </section>
  );
}
