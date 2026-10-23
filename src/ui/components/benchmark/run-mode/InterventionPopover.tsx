import { Popover as PopoverPrimitive } from 'radix-ui';
import { useId, useRef, useState } from 'react';
import type { PendingAsk, RunHive } from '@/components/benchmark/run-mode/run-hive';
import type { VirtualAnchor } from '@/components/MentionList';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

const CENTRE_HEIGHT = 3; // with no control to anchor to, a third down the window, where a dialog sits

// No focused control (a key's write): the window's centre stands in for the anchor
const centre = (): DOMRect => DOMRect.fromRect({ x: window.innerWidth / 2, y: window.innerHeight / CENTRE_HEIGHT, width: 0, height: 0 });

/** benchmark-run.hv.html's .first-iv (#469): the title (the first intervention, or a new one once the count moved), what it marks, the
 * don't-ask-again box, cancelar · aprovar e registrar. Escape and a click outside are cancelar. */
export function InterventionPopover({ run, ask }: { run: RunHive; ask: PendingAsk }) {
  const [isNoAsk, setIsNoAsk] = useState(false);
  const anchor = useRef<VirtualAnchor>({ getBoundingClientRect: () => ask.anchor?.getBoundingClientRect() ?? centre() });
  const titleId = useId();
  return (
    <PopoverPrimitive.Root open onOpenChange={(open) => { if (!open) ask.answer(false, false); }}>
      <PopoverPrimitive.Anchor virtualRef={anchor} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-labelledby={titleId} side="bottom" align="start" sideOffset={8} collisionPadding={8}
          className="z-50 flex w-[350px] flex-col gap-2.5 rounded-lg border border-empty bg-popover p-3.5 text-popover-foreground shadow-lg outline-hidden"
        >
          <h2 id={titleId} className="font-semibold text-[13px]">{t(run.interventions.length === 0 ? 'benchmark.run.ask.first' : 'benchmark.run.ask.next')}</h2>
          <p className="text-muted-foreground text-xs leading-[17px]">{t('benchmark.run.ask.text', { token: run.marker.token })}</p>
          <label className="flex items-center gap-2 text-muted-foreground text-xs">
            <input type="checkbox" checked={isNoAsk} onChange={() => setIsNoAsk((on) => !on)} className="size-3.5 accent-foreground" />
            {t('benchmark.run.ask.noAsk')}
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => ask.answer(false, false)}>{t('benchmark.run.ask.cancel')}</Button>
            <Button type="button" size="sm" onClick={() => ask.answer(true, isNoAsk)}>{t('benchmark.run.ask.approve')}</Button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
