import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { EffectiveLimits, Signal, State } from '../../types.js';
import { workerCount } from '../../worker-count.js';
import { SignalToggle } from '@/components/SignalToggle';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { signalEffect } from '@/lib/signal-effect';

interface HeaderBrandProps { state: State; effective: EffectiveLimits; isCompact?: boolean }

const NO_DRAG = '[-webkit-app-region:no-drag]';
const FOCUS_RING = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
// 6px under the header (header-estados.md): a 24px trigger centred in the 44px header sits 10px above its edge
const POPOVER_OFFSET = 16;
// The pointer going from the ⬢ to the popover leaves one before it enters the other: the close waits this long for it
const HOVER_CLOSE_MS = 150;
const CONTENT = { side: 'bottom', align: 'start', sideOffset: POPOVER_OFFSET, className: 'w-60 rounded-md p-1 shadow-[0_4px_12px_rgb(0_0_0/.45)]' } as const;

// The hexagon reads the effective signal at a glance, as the tray icon does
const SIGNAL_TEXT: Record<Signal, string> = { green: 'text-signal-green', yellow: 'text-signal-yellow', red: 'text-signal-red' };

// The mark is one filled hexagon, the honeycomb's centre cell (the handoff's ⬢), in the signal's colour. One size in every state (#295): it
// never resizes between the open brand, the closed ⬢ and the popover; the compact trigger's 24×24 is padding
function HiveMark({ signal }: { signal: Signal }) {
  return (
    <svg viewBox="-88 -88 176 176" aria-hidden="true" className={`size-3 shrink-0 ${SIGNAL_TEXT[signal]}`} data-signal={signal} fill="currentColor">
      <polygon points="0,-88 76,-44 76,44 0,88 -76,44 -76,-44" />
    </svg>
  );
}

// The title (header-estados.md): the signal, then what it holds back; a signal that holds nothing back drops the middle part. The toggle in
// the popover changes it, so no "click to change"
const brandTitle = (signal: Signal, effect: string | undefined): string =>
  (effect === undefined ? t('header.signalTitlePlain', { signal }) : t('header.signalTitle', { signal, effect }));

/** The header's workers count, and the shutdown confirm's context (#75). */
export const workersLine = (state: State, effective: EffectiveLimits): string =>
  t('header.workers', { active: workerCount(state.workers), max: effective.maxWorkers ?? state.maxConcurrent });

// One popover in both states (header-estados.md): the mark, hive, the workers on the right; a separator; then the flow sidebar's own toggle,
// with its fired rules' floor lock and the effect the signal settings name
function PopoverBody({ state, effective, workers }: Omit<HeaderBrandProps, 'isCompact'> & { workers: string }) {
  return (
    <>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <HiveMark signal={effective.signal} />
        <span className="font-semibold text-[13px]">{t('header.brand')}</span>
        <span className="ml-auto text-muted-foreground text-xs">{workers}</span>
      </div>
      <hr className="my-1 h-px border-0 bg-border" />
      <div className="px-2 pt-1 pb-2"><SignalToggle signal={state.signal} signals={state.signals} effective={effective} /></div>
    </>
  );
}

type Opener = 'hover' | 'focus';

// The closed ⬢'s popover (#295): it opens on hover, and on focus and click so the keyboard reaches it; it closes once the pointer has left both
// the ⬢ and the popover, on Escape and on a click outside (radix). A hover never moves the focus, neither into the popover nor back to the ⬢
// at its close; the focus a keyboard close hands back to the ⬢ must not open it again
function useHoverOpen() {
  const [isOpen, setIsOpen] = useState(false);
  const opener = useRef<Opener>('focus');
  const isReturning = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (by: Opener): void => {
    clearTimeout(timer.current);
    if (!isOpen) opener.current = by;
    setIsOpen(true);
  };
  // Only a hover's popover closes on the pointer leaving: one the keyboard or a click opened stays until Escape or a click outside
  const leave = (): void => {
    clearTimeout(timer.current);
    if (opener.current === 'hover') timer.current = setTimeout(() => setIsOpen(false), HOVER_CLOSE_MS);
  };
  const hover = { onPointerEnter: () => show('hover'), onPointerLeave: leave };
  const trigger = {
    ...hover,
    onFocus: () => { if (!isReturning.current) show('focus'); },
    onClick: (event: MouseEvent) => { event.preventDefault(); show('focus'); }, // opens, never toggles: a hover has already opened it
  };
  const content = {
    ...hover,
    onOpenAutoFocus: (event: Event) => { if (opener.current === 'hover') event.preventDefault(); },
    onCloseAutoFocus: (event: Event) => {
      if (opener.current === 'hover') return event.preventDefault();
      isReturning.current = true;
      setTimeout(() => { isReturning.current = false; }, 0);
    },
  };
  return { isOpen, setIsOpen, trigger, content };
}

// The left side closed (header-estados.md): the ⬢ alone in a 24×24 target, the mark itself unchanged
function CompactBrand({ title, signal, children }: { title: string; signal: Signal; children: ReactNode }) {
  const hover = useHoverOpen();
  return (
    <Popover open={hover.isOpen} onOpenChange={hover.setIsOpen}>
      <PopoverTrigger asChild {...hover.trigger}>
        <button type="button" aria-label={t('header.brand')} title={title} className={`flex size-6 shrink-0 items-center justify-center rounded-[6px] hover:bg-accent ${FOCUS_RING} ${NO_DRAG}`}>
          <HiveMark signal={signal} />
        </button>
      </PopoverTrigger>
      <PopoverContent {...CONTENT} aria-label={t('header.brand')} {...hover.content}>{children}</PopoverContent>
    </Popover>
  );
}

/** The header's brand (#221, #295): open, the mark in the effective signal's colour, hive, then the workers (#227: the footer no longer counts
 * them), opened by a click; compact (the left side closed), the mark alone, opened by hover, focus or click. Both open the same popover, with
 * the workers and the signal toggle; ⌘⌥1–3 still set the signal. */
export function HeaderBrand({ state, effective, isCompact = false }: HeaderBrandProps) {
  const workers = workersLine(state, effective);
  const title = brandTitle(effective.signal, signalEffect(effective.signal, state.signals));
  const body = <PopoverBody state={state} effective={effective} workers={workers} />;
  if (isCompact) return <CompactBrand title={title} signal={effective.signal}>{body}</CompactBrand>;
  // aria-label: the two spans would read "hive· workers" as a name, and the title is the longer hint
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${t('header.brand')} · ${workers}`} title={title} className={`flex h-6 min-w-0 items-center gap-1.5 rounded-sm ${FOCUS_RING} ${NO_DRAG}`}>
          <HiveMark signal={effective.signal} />
          <span className="font-semibold text-[13px]">{t('header.brand')}</span>
          <span className="truncate text-muted-foreground text-xs">{` · ${workers}`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent {...CONTENT} aria-label={t('header.brand')}>{body}</PopoverContent>
    </Popover>
  );
}
