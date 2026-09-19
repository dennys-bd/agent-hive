import { useState } from 'react';
import { columnOf, isBlocked } from '../../cards';
import type { Card as CardModel, Column, Status, State } from '../../types';
import { act } from '@/components/actions';
import { Confirm } from '@/components/Confirm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { statusText, t } from '@/i18n';
import { isFree } from '@/lib/usage';

interface HiveBoardProps { state: State }

const STATUS_BORDER: Record<Status, string> = { empty: 'border-empty', working: 'border-working', waiting: 'border-waiting', review: 'border-review' };

function BoardCard({ card, state }: { card: CardModel; state: State }) {
  const slot = state.slots.find((s) => s.id === card.slotId);
  const column = columnOf(state.columns, card.column);
  const id = encodeURIComponent(card.task.itemId);
  const meta = [slot ? statusText(slot.status) : undefined, card.branch ?? card.slug, card.orphan ? t('card.orphan') : undefined].filter(Boolean).join(' · ');
  const borderClass = card.missing ? 'border-destructive' : STATUS_BORDER[slot?.status ?? 'empty'];
  const freeSlot = state.slots.some(isFree);
  const nextMax = state.slots.filter((s) => s.status !== 'empty').length + 1;

  return (
    <div className={`rounded-md border border-l-4 p-2 text-sm ${borderClass} ${card.orphan ? 'opacity-70' : ''}`}>
      <div className="font-medium">{`#${card.task.id} ${card.task.title}`}</div>
      <div className="text-muted-foreground text-xs">{meta}</div>
      {card.prUrl && <a href={card.prUrl} target="_blank" rel="noreferrer" className="text-xs">PR</a>}
      {card.error && (
        <Badge variant="destructive" className="max-w-full" title={card.error}>
          <span className="truncate">{card.error}</span>
        </Badge>
      )}
      {card.missing ? (
        <div className="flex items-center gap-2 text-destructive text-xs">
          {t('card.missing')}
          <Confirm
            message={t('confirm.close')} confirmLabel={t('card.close')}
            trigger={<Button type="button" size="xs" variant="outline">{t('card.close')}</Button>}
            onConfirm={() => act(`/cards/${id}/close`)}
          />
          <Button type="button" size="xs" variant="outline" onClick={() => act(`/cards/${id}/keep`)}>{t('card.keep')}</Button>
        </div>
      ) : slot ? (
        <Button type="button" size="xs" variant="outline" onClick={() => act(`/slots/${slot.id}/focus`)}>terminal</Button>
      ) : isBlocked(card.task) ? (
        <div className="text-muted-foreground text-xs">{t('card.blockedBy', { ids: (card.task.blockedBy ?? []).join(', ') })}</div>
      ) : column?.prompt === undefined ? null : freeSlot ? (
        <Button type="button" size="xs" onClick={() => act(`/cards/${id}/start`)}>{t('card.start')}</Button>
      ) : (
        <Confirm
          message={t('confirm.raiseMax', { from: state.maxConcurrent, to: nextMax, id: card.task.id })} confirmLabel={t('card.start')}
          trigger={<Button type="button" size="xs">{t('card.start')}</Button>}
          onConfirm={() => act(`/cards/${id}/start`, { raiseMax: true })}
        />
      )}
    </div>
  );
}

interface ColumnCardsProps { cards: CardModel[]; column: Column; state: State }

/** Running cards always show and count against `column.visible`; the first stopped cards fill what is left, until the toggle reveals all. Absent or 0 = no cap. */
function ColumnCards({ cards, column, state }: ColumnCardsProps) {
  const [expanded, setExpanded] = useState(false);
  const cap = column.visible ?? 0;
  const running = cards.filter((c) => c.slotId);
  const stopped = cards.filter((c) => !c.slotId).slice(0, Math.max(cap - running.length, 0));
  const collapsed = cap === 0 ? cards : cards.filter((c) => c.slotId || stopped.includes(c)); // board order, only filtered
  const hidden = cards.length - collapsed.length; // 0 once a card leaves or the cap changes: the button goes and `expanded` no longer matters

  return (
    <>
      {(expanded ? cards : collapsed).map((card) => <BoardCard key={card.task.itemId} card={card} state={state} />)}
      {hidden > 0 && (
        <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded((e) => !e)}>
          {expanded ? t('column.less') : t('column.more', { n: hidden })}
        </Button>
      )}
    </>
  );
}

/** One card per configured column, each column's cards in board order behind the column's cap; a card's actions match what today's board offers. */
export function HiveBoard({ state }: HiveBoardProps) {
  return (
    <div className="flex gap-4 overflow-x-auto">
      {state.columns.map((column) => {
        const cards = state.cards.filter((c) => c.column === column.name);
        return (
          <Card key={column.name} className="min-w-56 flex-1 gap-2 p-3">
            <h3 className="text-muted-foreground text-xs uppercase">
              {`${column.name} · ${t('column.cards', { n: cards.length })} · ${t('column.weight', { w: column.weight })}`}
            </h3>
            {cards.length === 0
              ? <p className="text-muted-foreground text-xs">{t('column.empty')}</p>
              : <ColumnCards cards={cards} column={column} state={state} />}
          </Card>
        );
      })}
    </div>
  );
}
