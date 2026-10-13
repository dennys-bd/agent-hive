import { CoffeeIcon, PowerIcon } from 'lucide-react';
import { act } from '@/components/actions';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import type { Signal } from '../../../types.js';

interface PowerButtonsProps { keepAwake: boolean; armed: boolean; signal: Signal; workers: string }

// The shutdown confirm's context (the handoff's): the effective signal as its pill, the word green / yellow / red in every language, then the
// header's workers count
function ShutdownContext({ signal, workers }: { signal: Signal; workers: string }) {
  return (
    <span className="flex items-center gap-2">
      <span data-signal={signal} className="signal-pill rounded-full px-2 text-xs font-medium leading-[18px]">{signal}</span>
      {workers}
    </span>
  );
}

// The handoff's icon buttons (§3.7): 20px tall, a 14px icon, no label; off muted and borderless, on the border and icon in the status colour
// over 16% of it. Everything the button says is in its title, and aria-label carries the same text.
const BUTTON = 'size-5 rounded-sm border';
const OFF = 'border-transparent text-muted-foreground';
const KEEPING_AWAKE = 'border-working bg-working/16 text-working hover:bg-working/16 hover:text-working';
const SHUTTING_DOWN = 'border-waiting bg-waiting/16 text-waiting hover:bg-waiting/16 hover:text-waiting';

/** The footer's end (#226): keep awake toggles with one click; shutdown when done asks before arming (an idle Hive shuts down at once) and
 * cancels at once, as the old footer button did (#233). */
export function PowerButtons({ keepAwake, armed, signal, workers }: PowerButtonsProps) {
  const awakeTitle = t(keepAwake ? 'power.keepAwake.on' : 'power.keepAwake.off');
  const shutdownTitle = t(armed ? 'power.shutdown.on' : 'power.shutdown.off');
  const shutdown = (
    <Button
      type="button" variant="ghost" size="icon-xs" title={shutdownTitle} aria-label={shutdownTitle}
      className={`${BUTTON} ${armed ? SHUTTING_DOWN : OFF}`}
      onClick={armed ? () => { void act('/shutdown', { armed: false }); } : undefined}
    >
      <PowerIcon className="size-3.5" />
    </Button>
  );
  return (
    <span className="flex items-center gap-1">
      <Button
        type="button" variant="ghost" size="icon-xs" title={awakeTitle} aria-label={awakeTitle}
        className={`${BUTTON} ${keepAwake ? KEEPING_AWAKE : OFF}`}
        onClick={() => { void act('/keep-awake', { on: !keepAwake }); }}
      >
        <CoffeeIcon className="size-3.5" />
      </Button>
      {armed ? shutdown : (
        <Confirm
          title={t('confirm.title.shutdown')} context={<ShutdownContext signal={signal} workers={workers} />} message={t('confirm.shutdown')}
          confirmLabel={t('shutdown.arm')} trigger={shutdown} onConfirm={() => act('/shutdown', { armed: true })}
        />
      )}
    </span>
  );
}
