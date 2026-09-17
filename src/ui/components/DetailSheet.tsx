import { cardOf } from '../../cards';
import type { State } from '../../types';
import { act } from '@/components/actions';
import { Output } from '@/components/Output';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useOutput } from '@/hooks/use-output';
import { t } from '@/i18n';

// locale is part of the shared Dashboard signature (Header uses it); this component formats no clock itself.
interface DetailSheetProps { state: State; slotId?: string; locale: string; onClose(): void }

export function DetailSheet({ state, slotId, onClose }: DetailSheetProps) {
  const slot = state.slots.find((s) => s.id === slotId);
  const card = slot ? cardOf(state.cards, slot) : undefined;
  const lines = useOutput(slot?.id);
  const open = Boolean(slot && slot.status !== 'empty');

  return (
    <Sheet open={open} modal={false} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{`#${card?.task.id ?? ''} ${card?.task.title ?? ''}`}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-2 overflow-auto px-4 pb-4 text-sm">
          {card?.prUrl && <p><a href={card.prUrl} target="_blank" rel="noreferrer">{`PR: ${card.prUrl}`}</a></p>}
          {slot?.question && (
            <div>
              <p>{t('detail.pending')}</p>
              <pre className="whitespace-pre-wrap rounded-md bg-background p-2 text-xs">{slot.question}</pre>
            </div>
          )}
          <div className="text-muted-foreground text-xs">{`worktree: ${card?.worktree ?? '—'}`}</div>
          <div className="text-muted-foreground text-xs">{`branch: ${card?.branch ?? '—'}`}</div>
          {slot?.sessionId && (
            <div className="text-muted-foreground text-xs">
              {t('detail.session')} <code>{`claude --resume ${slot.sessionId}`}</code>
            </div>
          )}
          {card && (card.task.url.startsWith('http')
            ? <a href={card.task.url} target="_blank" rel="noreferrer" className="text-xs">issue</a>
            : <div className="text-muted-foreground text-xs">{`board: ${card.task.url}`}</div>)}
          <Output lines={lines} />
          <div className="mt-2 flex gap-2">
            <Button type="button" onClick={() => { if (slot) act(`/slots/${slot.id}/focus`); }}>{t('detail.focus')}</Button>
            <Button type="button" variant="outline" onClick={onClose}>{t('detail.close')}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
