import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

type RemovePhase = 'closed' | 'confirming' | 'removing';

// The × of a stored row (#965's handoff; the GitLab group's too, #1048): the first click puts the confirm in its place with focus on it, the
// second calls the route. Escape puts focus back on the ×; a blur, a click elsewhere included, closes it where focus went. A removed row goes
// with the list's re-read
export function RemoveAction({ name, onRemove }: { name: string; onRemove(): Promise<boolean> }) {
  const [phase, setPhase] = useState<RemovePhase>('closed');
  const xRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const shouldRefocus = useRef(false);
  useEffect(() => {
    if (phase === 'confirming') confirmRef.current?.focus();
    if (phase === 'closed' && shouldRefocus.current) xRef.current?.focus();
    shouldRefocus.current = false;
  }, [phase]);
  const close = (isRefocused: boolean): void => { shouldRefocus.current = isRefocused; setPhase('closed'); };
  const remove = (): void => {
    setPhase('removing');
    void onRemove().then((isRemoved) => { if (!isRemoved) setPhase('closed'); });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); // Settings' own Escape, on document, skips a prevented key: the page stays
    close(true);
  };
  if (phase === 'closed') {
    return (
      <Button ref={xRef} type="button" variant="ghost" size="icon-xs" aria-label={t('settings.accounts.remove.label', { name })} onClick={() => setPhase('confirming')}>
        <XIcon aria-hidden="true" />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">{t('settings.accounts.remove.confirmHint')}</span>
      <Button
        ref={confirmRef} type="button" variant="destructive" size="xs" disabled={phase === 'removing'} onClick={remove} onKeyDown={onKeyDown}
        onBlur={() => { if (phase === 'confirming') close(false); }}
      >
        {t('settings.accounts.remove.confirm')}
      </Button>
    </span>
  );
}
