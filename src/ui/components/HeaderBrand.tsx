import type { EffectiveLimits, Signal, State } from '../../types.js';
import { workerCount } from '../../worker-count.js';
import { SignalToggle } from '@/components/SignalToggle';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { signalEffect } from '@/lib/signal-effect';

interface HeaderBrandProps { state: State; effective: EffectiveLimits }

// The hexagon reads the effective signal at a glance, as the tray icon does
const SIGNAL_TEXT: Record<Signal, string> = { green: 'text-signal-green', yellow: 'text-signal-yellow', red: 'text-signal-red' };

// The mark is one filled hexagon, the honeycomb's centre cell (the handoff's ⬢), in the signal's colour
function HiveMark({ signal }: { signal: Signal }) {
  return (
    <svg viewBox="-88 -88 176 176" aria-hidden="true" className={`size-3 ${SIGNAL_TEXT[signal]}`} data-signal={signal} fill="currentColor">
      <polygon points="0,-88 76,-44 76,44 0,88 -76,44 -76,-44" />
    </svg>
  );
}

// The title (handoff §1): the signal, what it holds back, then what a click does; a signal that holds nothing back drops the middle part
const brandTitle = (signal: Signal, effect: string | undefined): string =>
  (effect === undefined ? t('header.signalTitlePlain', { signal }) : t('header.signalTitle', { signal, effect }));

/** The header's workers count, and the shutdown confirm's context (#75). */
export const workersLine = (state: State, effective: EffectiveLimits): string =>
  t('header.workers', { active: workerCount(state.workers), max: effective.maxWorkers ?? state.maxConcurrent });

/** The header's brand (#221): the mark in the effective signal's colour, hive, then the workers (#227: the footer no longer counts them). A click opens the
 * signal choice, the flow sidebar's own toggle with its fired rules' floor lock and the effect hint; ⌘⌥1–3 still set the signal. */
export function HeaderBrand({ state, effective }: HeaderBrandProps) {
  // aria-label: the two spans would read "hive· workers" as a name, and the title is the longer hint
  const workers = workersLine(state, effective);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${t('header.brand')} · ${workers}`} title={brandTitle(effective.signal, signalEffect(effective.signal, state.signals))} className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [-webkit-app-region:no-drag]">
          <HiveMark signal={effective.signal} />
          <span className="font-semibold text-[13px]">{t('header.brand')}</span>
          <span className="truncate text-muted-foreground text-xs">{` · ${workers}`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-64 p-3">
        <SignalToggle signal={state.signal} signals={state.signals} effective={effective} />
      </PopoverContent>
    </Popover>
  );
}
