import { cardOf } from '../../cards';
import type { Slot, State, Status } from '../../types';
import { act } from '@/components/actions';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { slotEventText, statusText, t } from '@/i18n';
import { elapsed, fmt } from '@/lib/usage';

// locale is part of the shared Dashboard signature (Header and DetailSheet use it); this component formats no clock itself.
interface SlotGridProps { state: State; locale: string; onSelect(id: string): void }

const STATUS_BORDER: Record<Status, string> = { empty: 'border-empty', working: 'border-working', waiting: 'border-waiting', review: 'border-review' };

function SlotCard({ slot, state, onSelect }: { slot: Slot; state: State; onSelect(id: string): void }) {
  const border = `border-l-4 ${STATUS_BORDER[slot.status]}`;
  if (slot.status === 'empty') {
    return <div className={`rounded-md border p-2 text-sm ${border}`}><div className="text-muted-foreground text-xs">{statusText('empty')}</div></div>;
  }
  const card = cardOf(state.cards, slot);
  const tokens = slot.tokens === undefined ? '' : ` · ${fmt(slot.tokens)} tokens`;
  const draining = slot.draining ? ` · ${t('card.draining')}` : '';
  return (
    // biome-ignore lint/a11y/useSemanticElements: nests two real buttons (terminal, kill), which a native <button> cannot contain
    <div
      className={`cursor-pointer rounded-md border p-2 text-sm ${border} ${slot.status === 'waiting' ? 'blink' : ''}`}
      role="button" tabIndex={0}
      onClick={() => onSelect(slot.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(slot.id); }}
    >
      <div className={slot.draining ? 'font-medium line-through' : 'font-medium'}>{`#${card?.task.id ?? ''} ${card?.task.title ?? ''}`}</div>
      <div className="text-muted-foreground text-xs">{`${statusText(slot.status)} · ${elapsed(slot.startedAt)}${draining}${tokens}`}</div>
      <div className="text-muted-foreground text-xs">{`${t('card.column')} ${card?.column ?? ''} · ${card?.branch ?? card?.slug ?? ''}`}</div>
      <div className="text-muted-foreground text-xs">{slot.lastEvent ? slotEventText(slot.lastEvent) : ''}</div>
      <div className="mt-1 flex gap-2">
        <Button type="button" size="xs" variant="outline" onClick={(e) => { e.stopPropagation(); act(`/slots/${slot.id}/focus`); }}>terminal</Button>
        <Confirm
          message={t('confirm.kill')} confirmLabel="kill"
          trigger={<Button type="button" size="xs" variant="destructive" onClick={(e) => e.stopPropagation()}>kill</Button>}
          onConfirm={() => act(`/slots/${slot.id}/kill`)}
        />
      </div>
    </div>
  );
}

/** One card per slot, in slot order; an occupied card opens the detail sheet, empty ones just show the status. */
export function SlotGrid({ state, onSelect }: SlotGridProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
      {state.slots.map((slot) => <SlotCard key={slot.id} slot={slot} state={state} onSelect={onSelect} />)}
    </div>
  );
}
